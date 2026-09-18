;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.persistence
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.logging :as log]
   [app.common.time :as ct]
   [app.common.uuid :as uuid]
   [app.main.data.changes :as dch]
   [app.main.data.common :as-alias dc]
   [app.main.data.helpers :as dsh]
   [app.main.data.notifications :as ntf]
   [app.main.data.workspace :as-alias dw]
   [app.main.errors :as errors]
   [app.main.refs :as refs]
   [app.main.repo :as rp]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

(declare ^:private run-persistence-task)
(declare ^:private resume-persistence)
(declare ^:private report-sustained-failure)

(log/set-level! :warn)

(def revn-data (atom {}))

;; Request ids of the sends in flight, written outside the store's event loop.
(defonce ^:private active-requests (atom #{}))
(def queue-conj (fnil conj #queue []))

(def force-persist? #(= % ::force-persist))

(def save-retry-config
  "Retry policy for the quick burst that follows a transport failure."
  {:max-retries 3
   :base-delay-ms 1000})

(def recovery-retry-config
  "Retry policy for a queue known to be failing: the cycle does the waiting."
  {:max-retries 0})

(def slow-retry-delay-ms
  "Pause between the attempts of a queue whose quick burst is spent."
  30000)

(def retry-give-up-ms
  "How long a failing queue keeps trying. Matches how long the backend
  remembers a commit id."
  (* 24 60 60 1000))

(def ^:private sustained-failure-threshold-ms
  "How long a queue keeps failing before it counts as an outage."
  (* 5 60 1000))

(def ^:private saving-stall-timeout-ms (* 5 60 1000))
(def ^:private saving-check-interval-ms 30000)
(def ^:private save-wait-timeout-ms (* 2 60 1000))

(defn wait-persisted-or-error
  "Returns an observable that emits the first terminal persistence status
   (nil | :saved) and completes. Raises when the queue has failed and, with
   a timeout-ms, when persistence does not settle in time."
  ([] (wait-persisted-or-error save-wait-timeout-ms))
  ([timeout-ms]
   (let [base (->> (rx/from-atom refs/persistence {:emit-current-value? true})
                   (rx/filter (fn [{:keys [status queue]}]
                                (or (= status :error)
                                    (and (empty? queue)
                                         (or (nil? status) (= status :saved))))))
                   (rx/take 1)
                   (rx/mapcat (fn [{:keys [status error]}]
                                (if (= status :error)
                                  (rx/throw (ex-info "Changes could not be saved"
                                                     (merge {:type :persistence :code :save-failed} error)))
                                  (rx/of status)))))]
     (cond->> base
       timeout-ms
       (rx/timeout timeout-ms
                   (rx/throw (ex-info "Timed out waiting for changes to be saved"
                                      {:type :persistence :code :save-timeout})))))))

(defn wait-persisted
  "Best-effort variant of `wait-persisted-or-error`: a failed or timed out
   save completes the observable silently instead of raising."
  ([] (wait-persisted nil))
  ([timeout-ms]
   (->> (wait-persisted-or-error timeout-ms)
        (rx/catch (fn [_] (rx/empty))))))

(defn force-persist-and-wait
  "Convenience that emits the force-persist event and then waits for
   persistence to settle. Returns the combined observable."
  ([] (force-persist-and-wait nil))
  ([timeout-ms]
   (rx/concat (rx/of ::force-persist) (wait-persisted timeout-ms))))

(defn- next-status
  "Refuses downgrades: a save in progress stays :saving, and a failed save
  stays :error until persistence is resumed."
  [from to]
  (cond
    (and (= to :pending) (= from :saving))         from
    (and (= from :error) (#{:pending :saving} to)) from
    :else                                          to))

(defn- update-status
  [status]
  (ptk/reify ::update-status
    ptk/UpdateEvent
    (update [_ state]
      (update state :persistence
              (fn [pstate]
                (log/trc :hint "update-status"
                         :from (:status pstate)
                         :to status)
                (let [status (next-status (:status pstate) status)]
                  (cond-> (assoc pstate :status status)
                    (#{:pending :saving} status)
                    (update :last-progress-at d/nilv (inst-ms (ct/now)))

                    (#{:error :saved} status)
                    (dissoc :run-id :last-progress-at :stall-reported?))))))))

(defn- failing-file-id
  "The file the queue is stuck on, which is not always the one on screen."
  [state]
  (let [{:keys [queue index]} (:persistence state)]
    (or (:file-id (get index (peek queue)))
        (:current-file-id state))))

(defn- retry-window-open?
  "True while a failing queue may still be sent again. Past this the backend
  has forgotten the commit id, so sending it once more could apply the same
  changes twice."
  [pstate]
  (let [since (:failing-since pstate)]
    (or (nil? since)
        (< (- (inst-ms (ct/now)) since) retry-give-up-ms))))

(defn- submit-persistence-report
  [hint data]
  (let [cause (ex-info hint (assoc data :type :persistence))]
    (errors/submit-report :event-name "handled-exception"
                          :hint hint
                          :report (errors/generate-report cause))))

(defn- report-stalled-persistence
  [now]
  (ptk/reify ::report-stalled-persistence
    ptk/UpdateEvent
    (update [_ state]
      (assoc-in state [:persistence :stall-reported?] true))

    ptk/EffectEvent
    (effect [_ state _]
      (let [{:keys [queue status run-id last-progress-at]} (:persistence state)]
        (submit-persistence-report
         "File saving has made no progress for more than five minutes"
         {:code :saving-stalled
          :file-id (failing-file-id state)
          :commit-id (peek queue)
          :run-id run-id
          :status status
          :queued-commits (count queue)
          :elapsed-ms (- now last-progress-at)
          :can-edit (dm/get-in state [:permissions :can-edit])
          :read-only? (dm/get-in state [:workspace-global :read-only?])
          :preview-id (dm/get-in state [:workspace-global :preview-id])
          :render-context-lost? (dm/get-in state [:render-state :lost])})))))

(defn- check-persistence
  []
  (ptk/reify ::check-persistence
    ptk/WatchEvent
    (watch [_ state _]
      (let [{:keys [status last-progress-at stall-reported?]} (:persistence state)
            now (inst-ms (ct/now))]
        (when (and (#{:pending :saving} status)
                   last-progress-at
                   (not stall-reported?)
                   (> (- now last-progress-at) saving-stall-timeout-ms))
          (rx/of (report-stalled-persistence now)))))))

(defn- update-file-revn
  [file-id revn]
  (ptk/reify ::update-file-revn
    ptk/UpdateEvent
    (update [_ state]
      (log/dbg :hint "update-file-revn" :file-id (dm/str file-id) :revn revn)
      (dsh/update-file state file-id #(update % :revn max revn)))

    ptk/EffectEvent
    (effect [_ _ _]
      (swap! revn-data update file-id (fnil max 0) revn))))

(defn- discard-commit
  [commit-id]
  (ptk/reify ::discard-commit
    ptk/UpdateEvent
    (update [_ state]
      (update state :persistence (fn [pstate]
                                   (-> pstate
                                       (update :queue (fn [queue]
                                                        (if (= commit-id (peek queue))
                                                          (pop queue)
                                                          (throw (ex-info "invalid state" {})))))
                                       (update :index dissoc commit-id)
                                       (assoc :last-progress-at (inst-ms (ct/now)))
                                       (dissoc :stall-reported?)))))))

(defn- append-commit
  "Event used internally to append the current change to the
  persistence queue."
  [{:keys [id] :as commit}]
  (let [run-id (uuid/next)]
    (ptk/reify ::append-commit
      ptk/UpdateEvent
      (update [_ state]
        (log/trc :hint "append-commit" :method "update" :commit-id (dm/str id))
        (update state :persistence
                (fn [pstate]
                  (-> pstate
                      (cond-> (not= :error (:status pstate))
                        (update :run-id d/nilv run-id))
                      (update :queue queue-conj id)
                      (update :index assoc id commit)))))

      ptk/WatchEvent
      (watch [_ state _]
        (let [pstate (:persistence state)]
          (cond
            ;; A new edit restarts a stopped queue from its head, while the
            ;; backend still recognizes the head's commit id and so cannot
            ;; apply it twice.
            (= :error (:status pstate))
            (when (retry-window-open? pstate)
              (rx/of (resume-persistence true)))

            (= run-id (:run-id pstate))
            (rx/of (update-status :saving)
                   (run-persistence-task))))))))

(defn- failure-action
  "What to do about a save that failed.

  :retry     warn and keep trying at a slower pace
  :warn      warn and let a later edit try again
  :resync    drop the unappliable edits and load the file as it stands
  :delegate  hand the cause to the general error handler"
  [cause]
  (let [{:keys [type code]} (ex-data cause)]
    (cond
      (contains? #{:vern-conflict :revn-conflict} code)      :resync
      (contains? #{:authentication :not-found :restriction} type) :delegate
      (rp/eventually-retryable? cause)                       :retry
      :else                                                  :warn)))

(defn- discard-queue
  "Drops every queued edit. Only for edits that can never be applied."
  []
  (ptk/reify ::discard-queue
    ptk/UpdateEvent
    (update [_ state]
      (assoc state :persistence {:queue #queue [] :index {} :status :saved}))))

(defn- sustained-failure-report
  "Reports a queue that has been failing long enough to count as an outage,
  once per run."
  [state]
  (let [pstate  (:persistence state)
        elapsed (when-let [since (:failing-since pstate)]
                  (- (inst-ms (ct/now)) since))]
    (if (and (some? elapsed)
             (> elapsed sustained-failure-threshold-ms)
             (not (::sustained-reported? pstate)))
      (rx/of (report-sustained-failure elapsed))
      (rx/empty))))

(defn- slow-retry-cycle
  "Attempts a halted queue at a slow pace until the queue resumes,
  persistence restarts, or the workspace closes."
  [stream]
  (let [stoper-s (rx/merge
                  (rx/filter (ptk/type? ::resume-persistence) stream)
                  (rx/filter (ptk/type? ::initialize-persistence) stream)
                  (rx/filter (ptk/type? ::dw/finalize-workspace) stream))]
    (->> (rx/timer slow-retry-delay-ms)
         (rx/map (fn [_]
                   (log/wrn :hint "retrying halted save"
                            :delay slow-retry-delay-ms)
                   (resume-persistence true)))
         (rx/take-until stoper-s))))

(defn- stale-failure?
  "True when a send failed for a commit another attempt has since saved, so
  there is nothing left to report. A failure the runner raises is never
  stale: there a missing commit is the fault being reported."
  [state commit-id from-send?]
  (and from-send?
       (let [commit (dm/get-in state [:persistence :index commit-id])]
         (or (nil? commit)
             (::acknowledged? commit)))))

(defn- persistence-failed
  ([commit-id cause]
   (persistence-failed commit-id cause false))
  ([commit-id cause from-send?]
   (ptk/reify ::persistence-failed
     ptk/UpdateEvent
     (update [_ state]
       (let [data (ex-data cause)]
         (if (stale-failure? state commit-id from-send?)
           state
           (update state :persistence
                   (fn [pstate]
                     (let [code (:code data :save-failed)]
                       (-> pstate
                           (assoc :status :error
                                  :error (assoc data
                                                :type :persistence
                                                :code code
                                                :cause-type (:type data)
                                                :commit-id commit-id
                                                :hint (ex-message cause)
                                                ::errors/handled? true))
                           ;; Compared here, where the previous code is still
                           ;; in place; the effect below reads the answer.
                           (assoc ::already-reported? (= code (:reported-failure pstate)))
                           (assoc :reported-failure code)
                           ;; Start of the current run of failures.
                           (update :failing-since d/nilv (inst-ms (ct/now)))
                           (dissoc :run-id :last-progress-at :stall-reported?))))))))

     ptk/WatchEvent
     (watch [_ state stream]
       (let [action (when-not (stale-failure? state commit-id from-send?)
                      (failure-action cause))]
         (log/wrn :hint "save failed"
                  :commit-id (dm/str commit-id)
                  :code (:code (ex-data cause) :save-failed)
                  :cause-type (:type (ex-data cause))
                  :action action)
         (case action
           nil (rx/empty)

           ;; The queued edits belong to a version the file does not carry.
           ;; Dropping them keeps the next edit from resending them.
           :resync
           (rx/of (ptk/data-event ::error cause)
                  (discard-queue)
                  (ptk/event ::dw/reload-current-file))

           ;; The general handler reports it and decides what the user sees.
           :delegate
           (rx/of (ptk/data-event ::error cause))

           (rx/merge
            (rx/of (ptk/data-event ::error cause))
            (sustained-failure-report state)
            (if (and (= :retry action)
                     (retry-window-open? (:persistence state)))
              (slow-retry-cycle stream)
              (rx/empty))))))

     ptk/EffectEvent
     (effect [_ state _]
       (case (when-not (stale-failure? state commit-id from-send?)
               (failure-action cause))
         ;; Warn without the global handlers, which may reload or navigate
         ;; away while the retained changes are still recoverable.
         (:retry :warn)
         (errors/flash-persistence cause (dm/get-in state [:persistence ::already-reported?]))

         ;; Nothing can be saved from here: the general handler chooses what
         ;; the user sees and reports it.
         :delegate
         (errors/on-error cause)

         nil)))))

(defn- report-sustained-failure
  "Submits the outage report, once per run of failures."
  [elapsed-ms]
  (ptk/reify ::report-sustained-failure
    ptk/UpdateEvent
    (update [_ state]
      (assoc-in state [:persistence ::sustained-reported?] true))

    ptk/EffectEvent
    (effect [_ state _]
      (let [{:keys [queue error]} (:persistence state)]
        (submit-persistence-report
         "File saving has been failing for more than five minutes"
         {:code :saving-sustained-failure
          :elapsed-ms elapsed-ms
          :cause-type (:cause-type error)
          :file-id (failing-file-id state)
          :queued-commits (count queue)})))))

(defn- clear-reported-failure
  "Forgets the failure the user was warned about. A non-nil `elapsed-ms`
  reports the end of a run already reported as an outage."
  [elapsed-ms]
  (ptk/reify ::clear-reported-failure
    ptk/UpdateEvent
    (update [_ state]
      (update state :persistence dissoc
              :reported-failure ::already-reported?
              :failing-since ::sustained-reported?))

    ptk/EffectEvent
    (effect [_ state _]
      (when (some? elapsed-ms)
        (submit-persistence-report
         "File saving recovered after failing for a long time"
         {:code :saving-recovered
          :elapsed-ms elapsed-ms
          :file-id (failing-file-id state)})))))

(defn- commit-persisted
  [commit]
  (ptk/reify ::commit-persisted
    IDeref
    (-deref [_] commit)

    ptk/UpdateEvent
    (update [_ state]
      ;; Keep the acknowledgment even if the queue runner has stopped.
      (-> state
          (d/update-in-when [:persistence :index (:id commit)]
                            assoc ::acknowledged? true)
          (update :persistence dissoc ::recovering?)))

    ptk/WatchEvent
    (watch [_ state _]
      ;; A save that lands takes away the warning left by an earlier failure.
      (let [{:keys [reported-failure failing-since] :as pstate} (:persistence state)]
        (when (some? reported-failure)
          (rx/of (clear-reported-failure
                  ;; Only a run reported as an outage reports its end.
                  (when (::sustained-reported? pstate)
                    (- (inst-ms (ct/now)) failing-since)))
                 (ntf/hide :tag :persistence)))))))

(defn- update-file-request
  "Issues the `update-file` request, tracked as active for its whole life,
  retries included, so a save waiting out a backoff counts as in flight."
  [request-id retry-config params]
  (rx/create
   (fn [subscriber]
     (swap! active-requests conj request-id)
     (let [source       (rp/with-retry
                          #(try
                             (rp/cmd! :update-file params)
                             (catch :default cause
                               (rx/throw cause)))
                          retry-config)
           subscription (.subscribe source subscriber)]
       (fn []
         (swap! active-requests disj request-id)
         (rx/dispose! subscription))))))

(defn- attempt-retry-config
  "The burst for a save that fails out of the blue; one attempt for a queue
  already known to be failing."
  [state]
  (if (dm/get-in state [:persistence ::recovering?])
    recovery-retry-config
    save-retry-config))

(defn- attempt-state
  "Classifies what should happen with a queued commit before sending it.
  The attempt stamp and the send decision both read this, so a commit is
  only ever stamped with a request that is actually going to be sent."
  [state commit-id]
  (let [commit (dm/get-in state [:persistence :index commit-id])]
    (cond
      (= :error (dm/get-in state [:persistence :status]))  :halted
      (nil? commit)                                        :missing-commit
      (::acknowledged? commit)                             :acknowledged
      (contains? @active-requests (::request-id commit))   :in-flight
      (not (dm/get-in state [:permissions :can-edit]))     :permission-denied
      :else                                                :ready)))

(defn- send-queued-commit
  "Sends one queued commit and maps its outcome to persistence events."
  [request-id session-id retry-config
   {:keys [id file-id file-revn file-vern changes features] :as commit}]
  (log/dbg :hint "sending save" :commit-id (dm/str id) :file-id (dm/str file-id))
  (let [params {:id file-id
                :revn (max file-revn (get @revn-data file-id 0))
                :vern file-vern
                :session-id session-id
                :origin (:origin commit)
                :created-at (:created-at commit)
                :commit-id id
                :changes (vec changes)
                :features features}]
    ;; UI read-only mode does not invalidate already queued edits.
    (->> (update-file-request request-id retry-config params)
         (rx/take 1)
         ;; A response that carries no revision, including one that never
         ;; arrived, is treated as a failed save rather than a saved file.
         (rx/if-empty nil)
         (rx/mapcat (fn [{:keys [revn]}]
                      (if (and (int? revn) (<= 0 revn))
                        (rx/of (update-file-revn file-id revn)
                               (commit-persisted commit))
                        (rx/throw (ex-info "The save response has no valid revision"
                                           {:type :persistence
                                            :code :invalid-save-response
                                            :file-id file-id})))))
         (rx/catch (fn [cause]
                     (rx/of (persistence-failed id cause true)))))))

(defn- persist-commit
  [commit-id]
  (let [request-id (uuid/next)]
    (ptk/reify ::persist-commit
      ptk/UpdateEvent
      (update [_ state]
        (if (= :ready (attempt-state state commit-id))
          ;; Stamp the attempt before any I/O, so a request in flight is
          ;; never sent twice in parallel.
          (assoc-in state [:persistence :index commit-id ::request-id] request-id)
          state))

      ptk/WatchEvent
      (watch [_ state _]
        (let [commit (dm/get-in state [:persistence :index commit-id])
              fail   (fn [code hint]
                       (rx/of (persistence-failed commit-id
                                                  (ex-info hint {:type :persistence
                                                                 :code code
                                                                 :commit-id commit-id
                                                                 :file-id (:file-id commit)}))))]
          (case (attempt-state state commit-id)
            :halted            (rx/empty)
            :missing-commit    (fail :missing-commit "A queued save has no change data")
            :acknowledged      (rx/of (commit-persisted commit))
            ;; The replacement runner listens for the original request's result.
            :in-flight         (rx/empty)
            :permission-denied (fail :save-permission-denied "Edit permission was lost before changes could be saved")
            :ready             (send-queued-commit request-id
                                                   (:session-id state)
                                                   (attempt-retry-config state)
                                                   commit)))))))


(defn- run-persistence-task
  []
  (ptk/reify ::run-persistence-task
    ptk/WatchEvent
    (watch [_ state stream]
      (let [queue (-> state :persistence :queue)]
        (cond
          (= :error (dm/get-in state [:persistence :status]))
          (rx/empty)

          (seq queue)
          (let [commit-id (peek queue)
                stoper-s (rx/merge
                          (rx/filter (ptk/type? ::run-persistence-task) stream)
                          (rx/filter (ptk/type? ::error) stream))]

            (log/dbg :hint "run-persistence-task" :commit-id (dm/str commit-id))
            (->> (rx/merge
                  (->> stream
                       (rx/filter (ptk/type? ::commit-persisted))
                       (rx/map deref)
                       (rx/filter #(= commit-id (:id %)))
                       (rx/take 1)
                       (rx/mapcat (fn [_]
                                    (rx/of (discard-commit commit-id)
                                           (run-persistence-task)))))
                  (rx/of (persist-commit commit-id)))
                 (rx/take-until stoper-s)))

          :else
          (rx/of (update-status :saved)))))))

(defn- resume-persistence
  "Starts the queue again. `recovering?` marks a queue known to be failing,
  which sends once per cycle instead of bursting."
  ([] (resume-persistence false))
  ([recovering?]
   (ptk/reify ::resume-persistence
     ptk/UpdateEvent
     (update [_ state]
       (update state :persistence
               (fn [pstate]
                 (-> pstate
                     (dissoc :error)
                     (assoc :run-id (uuid/next)
                            :status :saving
                            ::recovering? recovering?)
                     (update :last-progress-at d/nilv (inst-ms (ct/now)))))))
     ptk/WatchEvent
     (watch [_ _ _]
       (rx/of (run-persistence-task))))))

(defn- recover-persistence
  []
  (ptk/reify ::recover-persistence
    ptk/WatchEvent
    (watch [_ state _]
      (let [{:keys [queue index status error run-id] :as pstate} (:persistence state)
            commit (get index (peek queue))]
        (cond
          (and (seq queue)
               (or (not= status :error)
                   (and (= :save-permission-denied (:code error))
                        (retry-window-open? pstate)
                        (= (:file-id commit) (:current-file-id state))
                        (dm/get-in state [:permissions :can-edit]))))
          (rx/of (resume-persistence))

          (and (empty? queue)
               (not= status :error)
               (or run-id (#{:pending :saving} status)))
          (rx/of (update-status :saved)))))))

(def ^:private xf-mapcat-undo
  (mapcat :undo-changes))

(def ^:private xf-mapcat-redo
  (mapcat :redo-changes))

(defn- merge-commit
  [buffer]
  (->> (rx/from (group-by :file-id buffer))
       (rx/map (fn [[_ [item :as commits]]]
                 (let [uchg (into [] xf-mapcat-undo commits)
                       rchg (into [] xf-mapcat-redo commits)]
                   (-> item
                       (assoc :undo-changes uchg)
                       (assoc :redo-changes rchg)
                       (assoc :changes rchg)))))))

(defn initialize-persistence
  []
  (ptk/reify ::initialize-persistence
    ptk/UpdateEvent
    (update [_ state]
      (update state :persistence dissoc
              :reported-failure ::already-reported?
              :failing-since ::sustained-reported?))

    ptk/WatchEvent
    (watch [_ _ stream]
      (log/debug :hint "initialize persistence")
      (let [stoper-s (rx/filter (ptk/type? ::initialize-persistence) stream)

            local-commits-s
            (->> stream
                 (rx/filter dch/commit?)
                 (rx/map deref)
                 (rx/filter #(= :local (:source %)))
                 (rx/filter (complement empty?))
                 (rx/share))

            notifier-s
            (rx/merge
             (->> local-commits-s
                  (rx/debounce 3000)
                  (rx/tap #(log/trc :hint "persistence beat")))
             (->> stream
                  (rx/filter #(= % ::force-persist))))]

        (rx/merge
         (rx/of (recover-persistence))

         (->> stream
              (rx/filter #(or (ptk/type? ::dc/change-team-role %)
                              (ptk/type? ::dw/workspace-initialized %)))
              (rx/map (fn [_] (recover-persistence)))
              (rx/take-until stoper-s))

         (->> (rx/interval saving-check-interval-ms)
              (rx/map (fn [_] (check-persistence)))
              (rx/take-until stoper-s))

         (->> notifier-s
              (rx/map #(ptk/data-event ::persistence-notification))
              (rx/take-until stoper-s))

         (->> local-commits-s
              (rx/debounce 200)
              (rx/map (fn [_]
                        (update-status :pending)))
              (rx/take-until stoper-s))

         ;; Here we watch for local commits, buffer them in a small
         ;; chunks (very near in time commits) and append them to the
         ;; persistence queue
         (->> local-commits-s
              (rx/take-until stoper-s)
              (rx/buffer-until notifier-s)
              (rx/mapcat merge-commit)
              (rx/map append-commit)
              (rx/finalize (fn []
                             (log/debug :hint "finalize persistence: changes watcher"))))

         ;; Here we track all incoming remote commits for maintain
         ;; updated the local state with the file revn
         (->> stream
              (rx/filter dch/commit?)
              (rx/map deref)
              (rx/filter #(= :remote (:source %)))
              (rx/mapcat (fn [{:keys [file-id file-revn] :as commit}]
                           (rx/of (update-file-revn file-id file-revn))))
              (rx/take-until stoper-s)))))))
