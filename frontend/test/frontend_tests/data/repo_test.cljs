;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.repo-test
  (:require
   [app.main.repo :as repo]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]))

;; ---------------------------------------------------------------------------
;; retry classification
;; ---------------------------------------------------------------------------

(t/deftest retry-classification
  (t/testing "each failure says whether it can be repeated at once, later, or not at all"
    (doseq [[type fast? eventual?]
            [[:network             true  true]   ; js/fetch failure
             [:bad-gateway         true  true]   ; 502
             [:service-unavailable true  true]   ; 503
             [:gateway-error       true  true]   ; 504 and the 52x family
             [:offline             true  true]   ; browser offline
             ;; Repeating a rate limit at once makes it worse; waiting it
             ;; out does not.
             [:rate-limit          false true]   ; 429
             ;; A proxy answering in place of the backend keeps doing so,
             ;; and retrying would hide it from the user.
             [:unexpected-response false false]
             [:internal            false false]
             [:validation          false false]
             [:authentication      false false]
             [:authorization       false false]]]
      (let [err (ex-info (name type) {:type type})]
        (t/is (= fast? (repo/fast-retryable? err))
              (str type " fast-retryable?"))
        (t/is (= eventual? (repo/eventually-retryable? err))
              (str type " eventually-retryable?"))))))

(t/deftest an-error-carrying-no-data-is-never-retried
  (let [err (js/Error. "plain")]
    (t/is (not (repo/fast-retryable? err)))
    (t/is (not (repo/eventually-retryable? err)))))

;; ---------------------------------------------------------------------------
;; with-retry tests (async, using zero-delay config for speed)
;; ---------------------------------------------------------------------------

(def ^:private fast-config
  "Retry config with zero delay for fast tests."
  {:max-retries 3 :base-delay-ms 0})

(t/deftest with-retry-succeeds-immediately
  (t/testing "returns value when observable succeeds on first try"
    (t/async done
      (let [call-count (atom 0)
            obs-fn     (fn []
                         (swap! call-count inc)
                         (rx/of :ok))]
        (->> (repo/with-retry obs-fn fast-config)
             (rx/subs!
              (fn [val]
                (t/is (= :ok val))
                (t/is (= 1 @call-count))
                (done))
              (fn [err]
                (t/is false (str "unexpected error: " (ex-message err)))
                (done))))))))

(t/deftest with-retry-retries-on-retryable-error
  (t/testing "retries and eventually succeeds after transient failures"
    (t/async done
      (let [call-count (atom 0)
            obs-fn     (fn []
                         (let [n (swap! call-count inc)]
                           (if (< n 3)
                             ;; First two calls fail with retryable error
                             (rx/throw (ex-info "bad gateway" {:type :bad-gateway}))
                             ;; Third call succeeds
                             (rx/of :recovered))))]
        (->> (repo/with-retry obs-fn fast-config)
             (rx/subs!
              (fn [val]
                (t/is (= :recovered val))
                (t/is (= 3 @call-count))
                (done))
              (fn [err]
                (t/is false (str "unexpected error: " (ex-message err)))
                (done))))))))

(t/deftest with-retry-exhausts-retries
  (t/testing "propagates error after max retries exhausted"
    (t/async done
      (let [call-count (atom 0)
            obs-fn     (fn []
                         (swap! call-count inc)
                         (rx/throw (ex-info "offline" {:type :offline})))]
        (->> (repo/with-retry obs-fn fast-config)
             (rx/subs!
              (fn [_val]
                (t/is false "should not succeed")
                (done))
              (fn [err]
                ;; 1 initial + 3 retries = 4 total calls
                (t/is (= 4 @call-count))
                (t/is (= :offline (:type (ex-data err))))
                (done))))))))

(t/deftest with-retry-no-retry-on-non-retryable
  (t/testing "non-retryable errors propagate immediately without retry"
    (t/async done
      (let [call-count (atom 0)
            obs-fn     (fn []
                         (swap! call-count inc)
                         (rx/throw (ex-info "auth" {:type :authentication})))]
        (->> (repo/with-retry obs-fn fast-config)
             (rx/subs!
              (fn [_val]
                (t/is false "should not succeed")
                (done))
              (fn [err]
                (t/is (= 1 @call-count))
                (t/is (= :authentication (:type (ex-data err))))
                (done))))))))

(t/deftest with-retry-respects-max-retries-config
  (t/testing "respects custom max-retries setting"
    (t/async done
      (let [call-count (atom 0)
            config     {:max-retries 1 :base-delay-ms 0}
            obs-fn     (fn []
                         (swap! call-count inc)
                         (rx/throw (ex-info "offline" {:type :offline})))]
        (->> (repo/with-retry obs-fn config)
             (rx/subs!
              (fn [_val]
                (t/is false "should not succeed")
                (done))
              (fn [err]
                ;; 1 initial + 1 retry = 2 total
                (t/is (= 2 @call-count))
                (t/is (= :offline (:type (ex-data err))))
                (done))))))))

(t/deftest with-retry-mixed-errors
  (t/testing "retries retryable errors, then stops on non-retryable"
    (t/async done
      (let [call-count (atom 0)
            obs-fn     (fn []
                         (let [n (swap! call-count inc)]
                           (case n
                             1 (rx/throw (ex-info "gw" {:type :bad-gateway}))
                             2 (rx/throw (ex-info "auth" {:type :authentication}))
                             (rx/of :should-not-reach))))]
        (->> (repo/with-retry obs-fn fast-config)
             (rx/subs!
              (fn [_val]
                (t/is false "should not succeed")
                (done))
              (fn [err]
                (t/is (= 2 @call-count))
                (t/is (= :authentication (:type (ex-data err))))
                (done))))))))

;; ---------------------------------------------------------------------------
;; handle-response classification tests
;; ---------------------------------------------------------------------------

(defn- capture-error
  "Subscribes to `handle-response` for `response` and calls `k` with the
  `ex-data` of the raised error."
  [response k]
  (->> (repo/handle-response response)
       (rx/subs!
        (fn [_] (t/is false "expected an error response") (k nil))
        (fn [cause] (k (ex-data cause))))))

(def ^:private html-error-page
  "<html><head><title>Web Page Blocked</title></head><body>blocked</body></html>")

(t/deftest handle-response-gateway-statuses
  (t/testing "every edge status that never reached the backend is a gateway error"
    (t/async done
      (let [statuses [504 520 521 522 523 524]
            pending  (atom (count statuses))]
        (doseq [status statuses]
          (capture-error {:status status
                          :body html-error-page
                          :headers {"content-type" "text/html"}
                          :uri "https://design.penpot.app/api/main/methods/get-teams"}
                         (fn [data]
                           (t/is (= :gateway-error (:type data))
                                 (str "status " status " should be a gateway error"))
                           (t/is (= status (:status data))
                                 (str "status " status " should be carried through"))
                           (when (zero? (swap! pending dec))
                             (done)))))))))

(t/deftest handle-response-rate-limit
  (t/testing "a 429 with no interpretable body is a rate-limit error"
    (t/async done
      (capture-error {:status 429
                      :body ""
                      :headers {}
                      :uri "https://design.penpot.app/api/main/methods/get-teams"}
                     (fn [data]
                       (t/is (= :rate-limit (:type data)))
                       (t/is (= 429 (:status data)))
                       (done))))))

(t/deftest handle-response-intercepted-by-proxy
  (t/testing "an error page from a filtering proxy is not an internal error"
    (t/async done
      (capture-error {:status 403
                      :body html-error-page
                      :headers {"content-type" "text/html"
                                "server" "Zscaler/6.2"}
                      :uri "https://design.penpot.app/api/main/methods/update-file"}
                     (fn [data]
                       (t/is (= :unexpected-response (:type data)))
                       (t/is (= 403 (:status data)))
                       (done))))))

(t/deftest handle-response-keeps-body-excerpt
  (t/testing "a body too long to keep is cut short and marked as cut"
    (t/async done
      (capture-error {:status 403
                      :body (apply str (repeat 5000 "x"))
                      :headers {"content-type" "text/html"}
                      :uri "https://design.penpot.app/api/main/methods/update-file"}
                     (fn [data]
                       (t/is (= 503 (count (:data data))) "500 characters and an ellipsis")
                       (t/is (str/ends-with? (:data data) "..."))
                       (done))))))

(t/deftest handle-response-keeps-a-short-body-whole
  (t/testing "a body short enough to read is passed through untouched"
    (t/async done
      (capture-error {:status 403
                      :body html-error-page
                      :headers {"content-type" "text/html"}
                      :uri "https://design.penpot.app/api/main/methods/update-file"}
                     (fn [data]
                       (t/is (= html-error-page (:data data)))
                       (done))))))

(t/deftest handle-response-challenge-still-authorization
  (t/testing "a Cloudflare challenge keeps its own type"
    (t/async done
      (capture-error {:status 403
                      :body html-error-page
                      :headers {"server" "cloudflare"
                                "cf-mitigated" "challenge"}
                      :uri "https://design.penpot.app/api/main/methods/get-teams"}
                     (fn [data]
                       (t/is (= :authorization (:type data)))
                       (t/is (= :challenge-required (:code data)))
                       (done))))))

(t/deftest handle-response-keeps-backend-error
  (t/testing "an error the backend itself reported is passed through untouched"
    (t/async done
      (capture-error {:status 400
                      :body {:type :validation :code :missing-param}
                      :headers {"content-type" "application/transit+json"}
                      :uri "https://design.penpot.app/api/main/methods/update-file"}
                     (fn [data]
                       (t/is (= :validation (:type data)))
                       (t/is (= :missing-param (:code data)))
                       (t/is (= 400 (:status data)))
                       (done))))))

(t/deftest handle-response-undecodable-non-error-is-internal
  (t/testing "a non-error response we cannot interpret is still an internal error"
    (t/async done
      (capture-error {:status 301
                      :body html-error-page
                      :headers {"content-type" "text/html"}
                      :uri "https://design.penpot.app/api/main/methods/get-teams"}
                     (fn [data]
                       (t/is (= :internal (:type data)))
                       (t/is (= :unable-to-process-repository-response (:code data)))
                       (done))))))
