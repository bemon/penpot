;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.persistence-test
  (:require
   [app.common.time :as ct]
   [app.common.uuid :as uuid]
   [app.main.data.changes :as dch]
   [app.main.data.notifications :as ntf]
   [app.main.data.persistence :as dps]
   [app.main.data.render-wasm :as drw]
   [app.main.errors :as errors]
   [app.main.repo :as rp]
   [app.main.store :as st]
   [app.util.i18n :as i18n]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [frontend-tests.helpers.mock :as mock]
   [potok.v2.core :as ptk]))

(defn- local-commit
  [file-id]
  (ptk/data-event ::dch/commit
                  {:id (uuid/next)
                   :file-id file-id
                   :file-revn 0
                   :file-vern 0
                   :source :local
                   :features #{}
                   :redo-changes [{:type :mod-page :id (uuid/next) :name "Edited"}]
                   :undo-changes []}))

(t/deftest queued-edits-save-during-temporary-read-only-mode
  (doseq [read-only-event [(drw/context-lost)
                           #(assoc-in % [:workspace-global :read-only?] true)
                           #(assoc % :workspace-global {:read-only? true
                                                        :preview-id (uuid/next)})]]
    (let [file-id  (uuid/next)
          response (rx/subject)
          errors   (atom [])
          store    (ptk/store {:state {:permissions {:can-edit true}
                                       :files {file-id {:id file-id :revn 0}}}
                               :on-error #(swap! errors conj %)})]
      (with-redefs [rp/cmd! (mock/stub (fn [_ _] (rx/take 1 response)))]
        (try
          (ptk/emit! store (dps/initialize-persistence)
                     (local-commit file-id)
                     read-only-event
                     ::dps/force-persist)
          (rx/push! response {:revn 1})
          (t/is (= :saved (get-in @store [:persistence :status])))
          (t/is (empty? (get-in @store [:persistence :queue])))

          (ptk/emit! store (drw/context-restored)
                     #(assoc-in % [:workspace-global :read-only?] false)
                     (local-commit file-id)
                     ::dps/force-persist)
          (rx/push! response {:revn 2})
          (t/is (= :saved (get-in @store [:persistence :status])))
          (t/is (empty? (get-in @store [:persistence :queue])))
          (t/is (empty? @errors))
          (finally
            (rx/dispose! store)
            (rx/end! response)))))))

(t/deftest historical-preview-cannot-create-local-commits
  (let [file-id (uuid/next)
        output  (atom [])
        state   {:current-file-id file-id
                 :permissions {:can-edit true}
                 :files {file-id {:id file-id :revn 0 :vern 0}}
                 :workspace-global {:read-only? true :preview-id (uuid/next)}}
        event   (dch/commit-changes {:redo-changes [] :undo-changes []})]
    (when-let [result (ptk/watch event state (rx/empty))]
      (->> result (rx/subs! #(swap! output conj %))))
    (t/is (empty? @output))))

(defn- with-watchdog
  [f]
  (let [clock    (atom 0)
        ticks    (rx/subject)
        response (rx/subject)
        reports  (atom [])
        causes   (atom [])
        render   errors/generate-report
        file-id  (uuid/next)
        store    (ptk/store {:state {:current-file-id file-id
                                     :permissions {:can-edit true}
                                     :files {file-id {:id file-id :revn 0}}}
                             :on-error #(t/is false (str %))})]
    (with-redefs [ct/now                 (mock/stub #(ct/inst @clock))
                  rx/interval            (mock/stub (fn [_] ticks))
                  rp/cmd!                (mock/stub (fn [_ _] (rx/take 1 response)))
                  st/state               store
                  errors/generate-report (fn [cause]
                                           (swap! causes conj cause)
                                           (render cause))
                  errors/submit-report   (fn [& params]
                                           (swap! reports conj (apply hash-map params)))]
      (try
        (ptk/emit! store (dps/initialize-persistence))
        (f {:clock clock :ticks ticks :response response :causes causes
            :reports reports :store store :file-id file-id})
        (finally
          (rx/dispose! store)
          (rx/end! ticks)
          (rx/end! response))))))

(t/deftest stalled-request-is-reported-once-without-discarding-edits
  (with-watchdog
    (fn [{:keys [clock ticks reports causes store file-id]}]
      (ptk/emit! store (local-commit file-id) ::dps/force-persist)
      (reset! clock 300000)
      (rx/push! ticks :tick)
      (t/is (empty? @reports) "Five minutes must elapse before reporting")

      ;; More local edits must not reset the stalled request's clock.
      (reset! clock 300001)
      (ptk/emit! store (drw/context-lost)
                 (local-commit file-id) ::dps/force-persist)
      (rx/push! ticks :tick)
      (t/is (= 1 (count @reports)))
      (t/is (= "handled-exception" (:event-name (first @reports))))
      (let [data (ex-data (first @causes))]
        (t/is (= :saving-stalled (:code data)))
        (t/is (= file-id (:file-id data)))
        (t/is (true? (:render-context-lost? data))))

      (reset! clock 900000)
      (rx/push! ticks :tick)
      (t/is (= 1 (count @reports)) "Do not repeat a report for the same stall")
      (t/is (= :saving (get-in @store [:persistence :status])))
      (t/is (= 2 (count (get-in @store [:persistence :queue])))))))

(t/deftest successful-saves-reset-the-stall-clock-and-allow-a-new-report
  (with-watchdog
    (fn [{:keys [clock ticks response reports store file-id]}]
      (ptk/emit! store (local-commit file-id) ::dps/force-persist
                 (local-commit file-id) ::dps/force-persist)
      (reset! clock 290000)
      (rx/push! response {:revn 1})
      (reset! clock 300001)
      (rx/push! ticks :tick)
      (t/is (empty? @reports) "The queue is making progress")

      (reset! clock 590001)
      (rx/push! ticks :tick)
      (t/is (= 1 (count @reports)) "The second request has now stalled")

      (rx/push! response {:revn 2})
      (t/is (= :saved (get-in @store [:persistence :status])))
      (reset! clock 1000000)
      (rx/push! ticks :tick)
      (t/is (= 1 (count @reports)) "A saved file must not be reported")

      (ptk/emit! store (local-commit file-id) ::dps/force-persist)
      (reset! clock 1300001)
      (rx/push! ticks :tick)
      (t/is (= 2 (count @reports)) "A later stall gets its own report"))))

(t/deftest pending-edits-are-monitored-without-extending-the-deadline
  (with-watchdog
    (fn [{:keys [clock ticks reports store]}]
      (rx/push! ticks :tick)
      (t/is (empty? @reports) "An idle file must not be reported")
      (ptk/emit! store (#'dps/update-status :pending))
      (reset! clock 300001)
      (ptk/emit! store (#'dps/update-status :pending))
      (rx/push! ticks :tick)
      (t/is (= 1 (count @reports)))
      (ptk/emit! store (#'dps/update-status :error))
      (reset! clock 900000)
      (rx/push! ticks :tick)
      (t/is (= 1 (count @reports)) "Do not report an already failed save"))))

(t/deftest reinitializing-persistence-replaces-the-watchdog
  (let [active-timers (atom 0)
        ticks         (rx/subject)
        store         (ptk/store {:state {} :on-error #(t/is false (str %))})]
    (with-redefs [rx/interval (mock/stub
                               (fn [_]
                                 (rx/create
                                  (fn [subscriber]
                                    (swap! active-timers inc)
                                    (let [subscription (.subscribe ticks subscriber)]
                                      (fn []
                                        (rx/dispose! subscription)
                                        (swap! active-timers dec)))))))]
      (try
        (ptk/emit! store (dps/initialize-persistence))
        (t/is (= 1 @active-timers))
        (ptk/emit! store (dps/initialize-persistence))
        (t/is (= 1 @active-timers))
        (finally
          (rx/dispose! store)
          (rx/end! ticks))))
    (t/is (zero? @active-timers))))

(defn- with-persistence
  [f]
  (let [file-id  (uuid/next)
        response (rx/subject)
        failures (atom [])
        requests (atom [])
        store    (ptk/store {:state {:current-file-id file-id
                                     :permissions {:can-edit true}
                                     :files {file-id {:id file-id :revn 0}}}
                             :on-error #(t/is false (str %))})]
    (with-redefs [rp/cmd! (mock/stub (fn [cmd params]
                                       (swap! requests conj [cmd params])
                                       (rx/take 1 response)))
                  ;; Retries are asynchronous; the tests that cover them ask
                  ;; for them explicitly.
                  dps/save-retry-config {:max-retries 0 :base-delay-ms 0}
                  errors/flash (fn [& {:keys [cause]}]
                                 (swap! failures conj cause))]
      (try
        (ptk/emit! store (dps/initialize-persistence))
        (f {:file-id file-id :response response :failures failures
            :requests requests :store store})
        (finally
          (rx/dispose! store)
          (rx/end! response))))))

(t/deftest permission-loss-fails-without-discarding-queued-edits
  (with-persistence
    (fn [{:keys [file-id requests failures store]}]
      (ptk/emit! store (local-commit file-id)
                 #(assoc-in % [:permissions :can-edit] false)
                 ::dps/force-persist)
      (t/is (= :error (get-in @store [:persistence :status])))
      (t/is (= 1 (count (get-in @store [:persistence :queue]))))
      (t/is (empty? @requests))
      (t/is (= 1 (count @failures)))
      (ptk/emit! store (local-commit file-id) ::dps/force-persist
                 (#'dps/update-status :pending))
      (t/is (= :error (get-in @store [:persistence :status])))
      (t/is (= 2 (count (get-in @store [:persistence :queue])))))))

(t/deftest failed-request-retains-the-queue-and-is-not-retried-on-initialization
  (with-persistence
    (fn [{:keys [file-id response requests store]}]
      (ptk/emit! store (local-commit file-id) ::dps/force-persist
                 (local-commit file-id) ::dps/force-persist)
      (.error response (ex-info "Connection lost" {:type :network}))
      (ptk/emit! store (dps/initialize-persistence))
      (t/is (= :error (get-in @store [:persistence :status])))
      (t/is (= 2 (count (get-in @store [:persistence :queue]))))
      (t/is (= 1 (count @requests))))))

(t/deftest save-failures-use-a-translated-warning-except-for-authentication
  (doseq [cause-type [:network :offline :authentication]]
    (with-persistence
      (fn [{:keys [file-id response store]}]
        (let [notifications (atom [])]
          (with-redefs [errors/flash (fn [& params]
                                       (swap! notifications conj (apply hash-map params)))
                        i18n/tr (mock/stub #(str "translated:" %))]
            (ptk/emit! store (local-commit file-id) ::dps/force-persist)
            (.error response (ex-info "Raw transport details" {:type cause-type}))
            (t/is (= :error (get-in @store [:persistence :status])))
            (let [data (get-in @store [:persistence :error])]
              (ptk/handle-error (assoc data ::errors/instance (ex-info "Save failed" data))))
            (if (= cause-type :authentication)
              (t/is (empty? @notifications))
              (t/is (= ["translated:errors.save-failed"]
                       (mapv :hint @notifications))))))))))

(t/deftest missing-commit-is-an-error-instead-of-skipping-changes
  (with-persistence
    (fn [{:keys [requests store]}]
      (let [id (uuid/next)]
        (ptk/emit! store
                   #(assoc % :persistence {:queue (conj #queue [] id)
                                           :index {} :run-id (uuid/next)
                                           :status :saving})
                   (dps/initialize-persistence))
        (t/is (= :error (get-in @store [:persistence :status])))
        (t/is (= [id] (vec (get-in @store [:persistence :queue]))))
        (t/is (empty? @requests))))))

(t/deftest initialization-recovers-an-unsent-commit-with-a-dangling-run-id
  (with-persistence
    (fn [{:keys [file-id response requests store]}]
      (let [commit (assoc @(local-commit file-id) :changes [])
            id     (:id commit)]
        (ptk/emit! store
                   #(assoc % :persistence {:queue (conj #queue [] id)
                                           :index {id commit} :run-id (uuid/next)
                                           :status :saving})
                   (dps/initialize-persistence))
        (t/is (= 1 (count @requests)))
        (rx/push! response {:revn 1})
        (t/is (= :saved (get-in @store [:persistence :status])))
        (t/is (empty? (get-in @store [:persistence :queue])))))))

(t/deftest an-active-request-is-never-sent-twice
  (doseq [interrupt [[(dps/initialize-persistence)]
                     [(ptk/data-event ::dps/error)]]]
    (with-persistence
      (fn [{:keys [file-id response requests store]}]
        (apply ptk/emit! store (local-commit file-id) ::dps/force-persist interrupt)
        (ptk/emit! store (dps/initialize-persistence))
        (t/is (= 1 (count @requests)))
        (rx/push! response {:revn 1})
        (t/is (= :saved (get-in @store [:persistence :status])))
        (t/is (empty? (get-in @store [:persistence :queue])))))))

(t/deftest permission-restoration-resumes-the-queue
  (with-persistence
    (fn [{:keys [file-id response requests store]}]
      (ptk/emit! store (local-commit file-id) ::dps/force-persist
                 (local-commit file-id) ::dps/force-persist
                 #(assoc-in % [:permissions :can-edit] false))
      (rx/push! response {:revn 1})
      (t/is (= :error (get-in @store [:persistence :status])))
      (t/is (= 1 (count (get-in @store [:persistence :queue]))))
      (ptk/emit! store
                 #(assoc-in % [:permissions :can-edit] true)
                 (ptk/data-event :app.main.data.common/change-team-role))
      (t/is (= 2 (count @requests)))
      (rx/push! response {:revn 2})
      (t/is (= :saved (get-in @store [:persistence :status])))
      (t/is (empty? (get-in @store [:persistence :queue]))))))

(t/deftest recovery-keeps-an-acknowledgment-received-without-a-runner
  (with-persistence
    (fn [{:keys [file-id response requests store]}]
      (ptk/emit! store (local-commit file-id) ::dps/force-persist
                 (ptk/data-event ::dps/error))
      (rx/push! response {:revn 1})
      (t/is (= 1 (count (get-in @store [:persistence :queue]))))
      (ptk/emit! store (dps/initialize-persistence))
      (t/is (= 1 (count @requests)) "The acknowledged changes must not be sent again")
      (t/is (= :saved (get-in @store [:persistence :status])))
      (t/is (empty? (get-in @store [:persistence :queue]))))))

(t/deftest recovery-sends-again-a-save-with-an-unknown-outcome
  (with-persistence
    (fn [{:keys [file-id response requests store]}]
      (let [commit (assoc @(local-commit file-id) ::dps/request-id (uuid/next))
            id     (:id commit)]
        (ptk/emit! store
                   #(assoc % :persistence {:queue (conj #queue [] id)
                                           :index {id commit} :status :saving})
                   (dps/initialize-persistence))
        ;; The server answers a commit id it already applied with the stored
        ;; revision, so sending it again cannot duplicate the changes.
        (t/is (= 1 (count @requests)))
        (t/is (= id (:commit-id (second (first @requests)))))
        (rx/push! response {:revn 1})
        (t/is (= :saved (get-in @store [:persistence :status])))
        (t/is (empty? (get-in @store [:persistence :queue])))))))

(t/deftest initialization-flushes-buffered-edits-without-duplicating-them
  (with-persistence
    (fn [{:keys [file-id response requests store]}]
      (ptk/emit! store (local-commit file-id)
                 (dps/initialize-persistence)
                 ::dps/force-persist)
      (t/is (= 1 (count @requests)))
      (t/is (= 1 (count (get-in @store [:persistence :queue]))))
      (rx/push! response {:revn 1})
      (t/is (= :saved (get-in @store [:persistence :status]))))))

(t/deftest synchronous-save-results-do-not-leave-a-dangling-runner
  (with-persistence
    (fn [{:keys [file-id store]}]
      (with-redefs [rp/cmd! (mock/stub (fn [_ _] (rx/of {:revn 1})))]
        (ptk/emit! store (local-commit file-id) ::dps/force-persist)
        (t/is (= :saved (get-in @store [:persistence :status])))
        (t/is (empty? (get-in @store [:persistence :queue])))))))

(t/deftest empty-or-invalid-save-responses-preserve-the-queue-as-failed
  (doseq [result [(rx/empty) (rx/of nil) (rx/of {:revn -1})]]
    (with-persistence
      (fn [{:keys [file-id store]}]
        (with-redefs [rp/cmd! (mock/stub (fn [_ _] result))]
          (ptk/emit! store (local-commit file-id) ::dps/force-persist)
          (t/is (= :error (get-in @store [:persistence :status])))
          (t/is (= :invalid-save-response (get-in @store [:persistence :error :code])))
          (t/is (= 1 (count (get-in @store [:persistence :queue])))))))))

;; ---------------------------------------------------------------------------
;; transport retries
;; ---------------------------------------------------------------------------

(defn- with-timers
  "Runs `f` with every timer replaced by a subject the test fires by hand, so
  a test says what happened instead of waiting to see whether it did.

  `f` receives:
    :fire!          fires the timers armed at a delay
    :armed?         whether any timer is armed at a delay
    :fire-backoff!  fires the one backoff a pending retry is waiting on
    :fire-burst!    fires backoffs until the quick burst is spent

  The backoff helpers name no delay, so the shape of the backoff curve stays
  a detail of `with-retry`."
  [f]
  (let [pending  (atom {})
        fire!    (fn [ms]
                   (let [subjects (get @pending ms)]
                     (swap! pending dissoc ms)
                     (doseq [subject subjects]
                       (rx/push! subject 0))))
        backoff  (fn [] (first (remove #(= % dps/slow-retry-delay-ms) (keys @pending))))
        backoff! (fn [] (when-let [ms (backoff)] (fire! ms) true))]
    (with-redefs [rx/timer (fn [ms]
                             (let [subject (rx/subject)]
                               (swap! pending update ms (fnil conj []) subject)
                               subject))]
      (f {:fire!         fire!
          :armed?        (fn [ms] (boolean (seq (get @pending ms))))
          :backoff-armed? (fn [] (some? (backoff)))
          :fire-backoff! backoff!
          :fire-burst!   (fn []
                           ;; Each attempt arms the next backoff; the bound
                           ;; keeps a runaway retry from hanging the test.
                           (loop [remaining 10]
                             (when (and (pos? remaining) (backoff!))
                               (recur (dec remaining)))))}))))

(def ^:private burst-retry-config {:max-retries 3 :base-delay-ms 1})
(def ^:private no-retry-config {:max-retries 0 :base-delay-ms 0})

(defn- gateway-failure []
  (ex-info "gateway" {:type :gateway-error :status 524}))

(defn- with-failing-saves
  "Runs `f` against a store whose saves fail until the `succeed-from`th call.

  `opts` may carry a `:retry-config` and the `:cause` saves fail with. `f`
  receives the call counter, the warnings shown to the user, the file id and
  the store, and emits its own edits so a test says when the user works."
  ([succeed-from f]
   (with-failing-saves succeed-from {} f))
  ([succeed-from {:keys [retry-config cause]} f]
   (let [file-id (uuid/next)
         calls   (atom 0)
         flashes (atom [])
         store   (ptk/store {:state {:current-file-id file-id
                                     :permissions {:can-edit true}
                                     :files {file-id {:id file-id :revn 0}}}
                             :on-error #(t/is false (str %))})]
     (with-redefs [rp/cmd! (mock/stub
                            (fn [_ _]
                              (if (< (swap! calls inc) succeed-from)
                                (rx/throw (or cause (gateway-failure)))
                                (rx/of {:revn 1}))))
                   dps/save-retry-config (or retry-config burst-retry-config)
                   errors/flash (fn [& params]
                                  (swap! flashes conj (apply hash-map params)))]
       (try
         (ptk/emit! store (dps/initialize-persistence))
         (f {:calls calls :flashes flashes :file-id file-id :store store})
         (finally
           (rx/dispose! store)))))))

(t/deftest a-save-interrupted-by-the-network-is-sent-again
  (with-timers
    (fn [{:keys [fire-backoff!]}]
      (with-failing-saves
        3
        (fn [{:keys [calls store file-id]}]
          (ptk/emit! store (local-commit file-id) ::dps/force-persist)
          (t/is (= 1 @calls) "the send that fails")
          (fire-backoff!)
          (t/is (= 2 @calls) "the retry that fails too")
          (fire-backoff!)
          (t/is (= 3 @calls) "and the one that lands")
          (t/is (= :saved (get-in @store [:persistence :status])))
          (t/is (empty? (get-in @store [:persistence :queue]))))))))

(t/deftest a-halted-queue-keeps-trying-on-its-own
  (with-timers
    (fn [{:keys [fire! armed? fire-burst!]}]
      (with-failing-saves
        5
        (fn [{:keys [calls store file-id]}]
          (ptk/emit! store (local-commit file-id) ::dps/force-persist)
          (fire-burst!)
          (t/is (= 4 @calls) "the quick burst is spent")
          (t/is (= :error (get-in @store [:persistence :status])))

          ;; The user stops editing. Only the queue itself can save it now.
          (t/is (armed? dps/slow-retry-delay-ms) "a slow cycle is waiting")
          (fire! dps/slow-retry-delay-ms)
          (t/is (= 5 @calls))
          (t/is (= :saved (get-in @store [:persistence :status])))
          (t/is (empty? (get-in @store [:persistence :queue]))))))))

(t/deftest a-slow-cycle-sends-once-instead-of-bursting
  (with-timers
    (fn [{:keys [fire! backoff-armed? fire-burst!]}]
      (with-failing-saves
        1000
        (fn [{:keys [calls store file-id]}]
          (ptk/emit! store (local-commit file-id) ::dps/force-persist)
          (t/is (backoff-armed?) "the first failure does start a burst")
          (fire-burst!)
          (t/is (= 4 @calls) "one send and three retries")

          (fire! dps/slow-retry-delay-ms)
          (t/is (= 5 @calls) "a cycle sends once")
          (t/is (not (backoff-armed?)) "and starts no burst of its own")

          (fire! dps/slow-retry-delay-ms)
          (t/is (= 6 @calls) "and once more on the cycle after that")
          (t/is (not (backoff-armed?))))))))

(t/deftest a-save-waiting-out-a-backoff-is-not-sent-again
  (with-timers
    (fn [{:keys [fire-backoff!]}]
      (with-failing-saves
        2
        (fn [{:keys [calls store file-id]}]
          (ptk/emit! store (local-commit file-id) ::dps/force-persist)
          (t/is (= 1 @calls) "the first send has failed")

          ;; The retry is waiting out its backoff. A recovery landing now
          ;; finds the queue non-empty and the save in flight.
          (ptk/emit! store (#'dps/recover-persistence))
          (t/is (= 1 @calls) "a save waiting out a backoff is still in flight")

          (fire-backoff!)
          (t/is (= 2 @calls) "only the retry follows")
          (t/is (= :saved (get-in @store [:persistence :status])))
          (t/is (empty? (get-in @store [:persistence :queue]))))))))

(t/deftest a-resume-on-a-healthy-queue-keeps-the-quick-burst
  (with-timers
    (fn [{:keys [backoff-armed?]}]
      (let [commit  @(local-commit (uuid/next))
            id      (:id commit)
            file-id (:file-id commit)
            calls   (atom 0)
            store   (ptk/store {:state {:current-file-id file-id
                                        :permissions {:can-edit true}
                                        :files {file-id {:id file-id :revn 0}}}
                                :on-error #(t/is false (str %))})]
        (with-redefs [rp/cmd! (mock/stub (fn [_ _] (swap! calls inc) (rx/throw (gateway-failure))))
                      dps/save-retry-config burst-retry-config
                      errors/flash (fn [& _] nil)]
          (try
            ;; A workspace reopening with queued edits resumes them. That
            ;; queue is healthy, so a failing save gets the full burst.
            (ptk/emit! store
                       #(assoc % :persistence {:queue (conj #queue [] id)
                                               :index {id commit}
                                               :status :saving})
                       (dps/initialize-persistence))
            (t/is (= 1 @calls))
            (t/is (backoff-armed?) "a resume of this kind keeps the quick burst")
            (finally
              (rx/dispose! store))))))))

(t/deftest leaving-the-workspace-stops-the-slow-cycle
  (with-timers
    (fn [{:keys [fire! armed?]}]
      (with-failing-saves
        1000
        {:retry-config no-retry-config}
        (fn [{:keys [calls store file-id]}]
          (ptk/emit! store (local-commit file-id) ::dps/force-persist)
          (t/is (= 1 @calls) "the save has failed and the cycle is armed")
          (t/is (armed? dps/slow-retry-delay-ms))

          ;; The user goes back to the dashboard: nothing keeps trying
          ;; against a closed workspace.
          (ptk/emit! store (ptk/data-event :app.main.data.workspace/finalize-workspace))
          (fire! dps/slow-retry-delay-ms)
          (t/is (= 1 @calls) "the cycle stopped with the workspace"))))))

(t/deftest a-retryable-failure-bursts-and-then-keeps-cycling
  (doseq [type [:gateway-error :network :offline :bad-gateway :service-unavailable]]
    (with-timers
      (fn [{:keys [armed? fire-burst!]}]
        (with-failing-saves
          1000
          {:cause (ex-info (name type) {:type type})}
          (fn [{:keys [calls store file-id]}]
            (ptk/emit! store (local-commit file-id) ::dps/force-persist)
            (fire-burst!)
            (t/is (= 4 @calls) (str type " is sent four times"))
            (t/is (armed? dps/slow-retry-delay-ms)
                  (str type " keeps trying at a slower pace"))
            (t/is (= :error (get-in @store [:persistence :status]))
                  (str type " stops the queue"))
            (t/is (= type (get-in @store [:persistence :error :cause-type]))
                  (str type " is carried into the error"))
            (t/is (= 1 (count (get-in @store [:persistence :queue])))
                  (str type " keeps its edits"))))))))

(t/deftest a-failure-that-cannot-be-retried-is-sent-once
  (doseq [type [:validation :authorization :internal :unexpected-response]]
    (with-timers
      (fn [{:keys [armed? backoff-armed?]}]
        (with-failing-saves
          1000
          {:cause (ex-info (name type) {:type type})}
          (fn [{:keys [calls store file-id]}]
            (ptk/emit! store (local-commit file-id) ::dps/force-persist)
            (t/is (= 1 @calls) (str type " is sent once"))
            (t/is (not (backoff-armed?)) (str type " starts no burst"))
            (t/is (not (armed? dps/slow-retry-delay-ms))
                  (str type " starts no slow cycle: the server refused it"))
            (t/is (= :error (get-in @store [:persistence :status])))
            (t/is (= 1 (count (get-in @store [:persistence :queue])))
                  (str type " still keeps its edits"))))))))

(t/deftest every-attempt-of-a-save-carries-the-same-commit-id
  (with-timers
    (fn [{:keys [fire-burst!]}]
      (let [file-id (uuid/next)
            sent    (atom [])
            store   (ptk/store {:state {:current-file-id file-id
                                        :permissions {:can-edit true}
                                        :files {file-id {:id file-id :revn 0}}}
                                :on-error #(t/is false (str %))})]
        (with-redefs [rp/cmd! (mock/stub (fn [_ params]
                                           (swap! sent conj params)
                                           (rx/throw (gateway-failure))))
                      dps/save-retry-config burst-retry-config
                      errors/flash (fn [& _] nil)]
          (try
            (ptk/emit! store (dps/initialize-persistence))
            (ptk/emit! store (local-commit file-id) ::dps/force-persist)
            (fire-burst!)

            ;; Repeating a save is only safe because the server recognises
            ;; the commit id, so every attempt has to carry the same one.
            (t/is (= 4 (count @sent)))
            (t/is (= 1 (count (distinct (map :commit-id @sent))))
                  "every attempt sends one and the same commit id")
            (t/is (every? some? (map :commit-id @sent)))
            (finally
              (rx/dispose! store))))))))

;; ---------------------------------------------------------------------------
;; warnings shown to the user
;; ---------------------------------------------------------------------------

(t/deftest an-edit-after-a-halted-queue-sends-everything-again
  (with-failing-saves
    2
    {:retry-config no-retry-config}
    (fn [{:keys [calls store file-id]}]
      (ptk/emit! store (local-commit file-id) ::dps/force-persist)
      (t/is (= :error (get-in @store [:persistence :status])))
      (t/is (= 1 (count (get-in @store [:persistence :queue]))))

      ;; The user keeps working; the new edit revives the stopped queue.
      (ptk/emit! store (local-commit file-id) ::dps/force-persist)
      (t/is (= 3 @calls) "the failed save and both queued commits")
      (t/is (= :saved (get-in @store [:persistence :status])))
      (t/is (empty? (get-in @store [:persistence :queue]))))))

(t/deftest a-repeated-failure-warns-the-user-without-reporting-twice
  (with-failing-saves
    1000
    {:retry-config no-retry-config
     :cause (ex-info "gateway" {:type :gateway-error :code :gateway-error})}
    (fn [{:keys [flashes store file-id]}]
      (ptk/emit! store (local-commit file-id) ::dps/force-persist)
      (ptk/emit! store (local-commit file-id) ::dps/force-persist)
      (t/is (= :error (get-in @store [:persistence :status])))
      (t/is (= 2 (count @flashes)) "the user is warned about every failed save")
      (t/is (= [:handled :silent] (mapv :type @flashes))
            "the same failure is reported once"))))

(t/deftest a-recovered-save-takes-the-warning-away
  (with-failing-saves
    2
    {:retry-config no-retry-config}
    (fn [{:keys [flashes store file-id]}]
      (let [hidden (atom [])]
        (with-redefs [ntf/hide (fn [& params]
                                 (swap! hidden conj (apply hash-map params))
                                 (ptk/data-event ::hidden))]
          (ptk/emit! store (local-commit file-id) ::dps/force-persist)
          (t/is (= :error (get-in @store [:persistence :status])))
          (t/is (= [:persistence] (mapv :tag @flashes))
                "the warning is tagged so only it can be taken away")
          (t/is (empty? @hidden))

          (ptk/emit! store (local-commit file-id) ::dps/force-persist)
          (t/is (= :saved (get-in @store [:persistence :status])))
          (t/is (= [{:tag :persistence}] @hidden)))))))

(t/deftest a-failure-arriving-after-the-commit-was-saved-is-ignored
  (with-failing-saves
    1
    {:retry-config no-retry-config}
    (fn [{:keys [flashes store file-id]}]
      (let [event  (local-commit file-id)
            commit (deref event)]
        (ptk/emit! store event ::dps/force-persist)
        (t/is (= :saved (get-in @store [:persistence :status])))
        (t/is (empty? (get-in @store [:persistence :queue])))

        ;; An orphaned chain can fail after its commit was saved and
        ;; dropped; the user must not be told work was lost.
        (ptk/emit! store (#'dps/persistence-failed
                          (:id commit)
                          (gateway-failure)
                          true))
        (t/is (= :saved (get-in @store [:persistence :status])))
        (t/is (empty? @flashes))))))

(t/deftest permission-restoration-resumes-an-edit-already-attempted
  (with-persistence
    (fn [{:keys [file-id response requests store]}]
      (let [commit (assoc @(local-commit file-id) ::dps/request-id (uuid/next))
            id     (:id commit)]
        ;; The commit was sent once, its answer never arrived, and then edit
        ;; permission was lost. Sending it again cannot duplicate it, so it
        ;; must not stay stranded until the user happens to edit again.
        (ptk/emit! store
                   #(-> %
                        (assoc :persistence {:queue (conj #queue [] id)
                                             :index {id commit}
                                             :status :error
                                             :error {:code :save-permission-denied}})
                        (assoc-in [:permissions :can-edit] false))
                   #(assoc-in % [:permissions :can-edit] true)
                   (ptk/data-event :app.main.data.common/change-team-role))
        (t/is (= 1 (count @requests)))
        (rx/push! response {:revn 1})
        (t/is (= :saved (get-in @store [:persistence :status])))
        (t/is (empty? (get-in @store [:persistence :queue])))))))

;; ---------------------------------------------------------------------------
;; telling an outage apart from a blip
;; ---------------------------------------------------------------------------

(defn- with-reports
  "Runs `f` with the clock in hand and every report collected, so a test can
  let time pass and say what was reported."
  [f]
  (let [clock   (atom 0)
        reports (atom [])
        causes  (atom [])
        render  errors/generate-report]
    (with-redefs [ct/now                 (mock/stub #(ct/inst @clock))
                  errors/generate-report (fn [cause]
                                           (swap! causes conj cause)
                                           (render cause))
                  errors/submit-report   (fn [& params]
                                           (swap! reports conj (apply hash-map params)))]
      (f {:clock clock :reports reports :causes causes}))))

(def ^:private outage-threshold-ms @#'dps/sustained-failure-threshold-ms)
(def ^:private under-threshold-ms (quot outage-threshold-ms 3))
(def ^:private over-threshold-ms (+ outage-threshold-ms 10000))

(defn- report-codes
  [causes]
  (mapv #(:code (ex-data %)) @causes))

(t/deftest a-save-failing-for-a-long-time-is-reported-once-more
  (with-timers
    (fn [{:keys [fire!]}]
      (with-reports
        (fn [{:keys [clock reports causes]}]
          (with-failing-saves
            1000
            {:retry-config no-retry-config}
            (fn [{:keys [store file-id]}]
              (ptk/emit! store (local-commit file-id) ::dps/force-persist)
              (t/is (empty? @reports) "one failed save is not yet an outage")

              (reset! clock under-threshold-ms)
              (fire! dps/slow-retry-delay-ms)
              (t/is (empty? @reports) "and neither is it a short while later")

              (reset! clock over-threshold-ms)
              (fire! dps/slow-retry-delay-ms)
              (t/is (= [:saving-sustained-failure] (report-codes causes))
                    "a queue failing this long is worth its own report")
              (t/is (= over-threshold-ms (:elapsed-ms (ex-data (last @causes)))))

              (reset! clock (* 3 outage-threshold-ms))
              (fire! dps/slow-retry-delay-ms)
              (t/is (= 1 (count @reports)) "and is reported only once"))))))))

(t/deftest a-save-coming-back-after-an-outage-is-reported
  (with-timers
    (fn [{:keys [fire!]}]
      (with-reports
        (fn [{:keys [clock causes]}]
          (with-failing-saves
            4
            {:retry-config no-retry-config}
            (fn [{:keys [store file-id]}]
              (ptk/emit! store (local-commit file-id) ::dps/force-persist)
              (fire! dps/slow-retry-delay-ms)

              (reset! clock over-threshold-ms)
              (fire! dps/slow-retry-delay-ms)
              (t/is (= [:saving-sustained-failure] (report-codes causes)))

              ;; The connection comes back and the queue drains.
              (reset! clock (* 2 outage-threshold-ms))
              (fire! dps/slow-retry-delay-ms)
              (t/is (= :saved (get-in @store [:persistence :status])))
              (t/is (= [:saving-sustained-failure :saving-recovered]
                       (report-codes causes))
                    "how long the outage lasted is the part support needs")
              (t/is (= (* 2 outage-threshold-ms)
                       (:elapsed-ms (ex-data (last @causes))))))))))))

(t/deftest a-save-that-stumbles-once-is-not-reported-as-an-outage
  (with-timers
    (fn [{:keys [fire!]}]
      (with-reports
        (fn [{:keys [reports]}]
          (with-failing-saves
            2
            {:retry-config no-retry-config}
            (fn [{:keys [store file-id]}]
              (ptk/emit! store (local-commit file-id) ::dps/force-persist)
              (fire! dps/slow-retry-delay-ms)
              (t/is (= :saved (get-in @store [:persistence :status])))
              (t/is (empty? @reports)
                    "a blip is covered by the warning the user already saw"))))))))

(defn- queued-state
  "A store state holding one commit, queued and being saved."
  []
  (let [file-id (uuid/next)
        commit  @(local-commit file-id)
        id      (:id commit)]
    [id {:current-file-id file-id
         :permissions {:can-edit true}
         :persistence {:queue (conj #queue [] id)
                       :index {id commit}
                       :status :saving}}]))

(defn- failure-events
  "Types of the events one failed save emits, without running them."
  [cause]
  (let [[id state] (queued-state)
        emitted    (atom [])]
    (when-let [result (ptk/watch (#'dps/persistence-failed id cause true) state (rx/empty))]
      (->> result (rx/subs! #(swap! emitted conj %))))
    (mapv ptk/type @emitted)))

(defn- failure-flashes
  "Warnings one failed save shows the user."
  [cause]
  (let [[id state] (queued-state)
        flashes    (atom [])]
    (with-redefs [errors/flash (fn [& params] (swap! flashes conj params))]
      (ptk/effect (#'dps/persistence-failed id cause true) state (rx/empty)))
    @flashes))

(t/deftest a-client-out-of-step-with-the-server-reloads-the-file
  ;; The queued edits belong to a version the file does not carry, so the
  ;; next edit would resend them and conflict anew.
  (t/is (seq (failure-flashes (gateway-failure)))
        "a transport failure does warn, so an empty result below means something")
  (doseq [code [:vern-conflict :revn-conflict]]
    (let [cause (ex-info (name code) {:type :validation :code code})
          types (failure-events cause)]
      (t/is (some #{:app.main.data.workspace/reload-current-file} types)
            (str code " loads the file as it now stands"))
      (t/is (some #{::dps/discard-queue} types)
            (str code " drops the edits that can never be applied"))

      (t/is (empty? (failure-flashes cause))
            (str code " reloads rather than warning about edits already gone")))))

(t/deftest a-failure-no-save-can-recover-from-goes-to-the-general-handler
  (doseq [type [:authentication :not-found :restriction]]
    (let [flashes  (atom [])
          reported (atom [])
          file-id  (uuid/next)
          commit   @(local-commit file-id)
          id       (:id commit)
          state    {:current-file-id file-id
                    :persistence {:queue (conj #queue [] id)
                                  :index {id commit}
                                  :status :saving}}
          cause    (ex-info (name type) {:type type})]
      (with-redefs [errors/flash    (fn [& params] (swap! flashes conj params))
                    errors/on-error (fn [c] (swap! reported conj c))]
        (ptk/effect (#'dps/persistence-failed id cause true) state (rx/empty))
        ;; The general handler shows what is wrong, rather than a toast
        ;; that leaves the user editing into a void.
        (t/is (= [cause] @reported) (str type " is handled as itself"))
        (t/is (empty? @flashes) (str type " shows no save warning"))))))
