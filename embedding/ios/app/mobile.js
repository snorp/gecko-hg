pref("toolkit.defaultChromeURI", "chrome://browser/content/browser.xul");
pref("browser.dom.window.dump.enabled", true);
pref("dom.max_script_run_time", 0);

pref("dom.w3c_touch_events.enabled", 1);
pref("full-screen-api.enabled", true);

pref("toolkit.storage.synchronous", 0);
pref("browser.viewport.desktopWidth", 980);
pref("browser.viewport.defaultZoom", -1);
pref("ui.scrollbarsCanOverlapContent", 1);
pref("ui.caretBlinkCount", 10);

pref("layers.async-pan-zoom.enabled", true);
pref("apz.allow_zooming", true);
pref("layers.max-active", 20);

pref("gfx.color_management.mode", 0);

pref("dom.meta-viewport.enabled", true);

pref("layout.accessiblecaret.enabled", true);

/* cache prefs */
pref("browser.cache.disk.enable", true);
pref("browser.cache.disk.capacity", 20480); // kilobytes
pref("browser.cache.disk.max_entry_size", 4096); // kilobytes
pref("browser.cache.disk.smart_size.enabled", true);
pref("browser.cache.disk.smart_size.first_run", true);

// iOS devices don't have a ton of memory
pref("browser.cache.memory.enable", false);

/* image cache prefs */
pref("image.cache.size", 1048576); // bytes

/* offline cache prefs */
pref("browser.offline-apps.notify", true);
pref("browser.cache.offline.enable", true);
pref("browser.cache.offline.capacity", 5120); // kilobytes
pref("offline-apps.quota.warn", 1024); // kilobytes

// cache compression turned off for now - see bug #715198
pref("browser.cache.compression_level", 0);

/* disable some protocol warnings */
pref("network.protocol-handler.warn-external.tel", false);
pref("network.protocol-handler.warn-external.sms", false);
pref("network.protocol-handler.warn-external.mailto", false);
pref("network.protocol-handler.warn-external.vnd.youtube", false);

/* http prefs */
pref("network.http.pipelining", true);
pref("network.http.pipelining.ssl", true);
pref("network.http.proxy.pipelining", true);
pref("network.http.pipelining.maxrequests" , 6);
pref("network.http.keep-alive.timeout", 109);
pref("network.http.max-connections", 20);
pref("network.http.max-persistent-connections-per-server", 6);
pref("network.http.max-persistent-connections-per-proxy", 20);

// spdy
pref("network.http.spdy.push-allowance", 32768);

// See bug 545869 for details on why these are set the way they are
pref("network.buffer.cache.count", 24);
pref("network.buffer.cache.size",  16384);

// predictive actions
pref("network.predictor.enabled", true);
pref("network.predictor.max-db-size", 2097152); // bytes
pref("network.predictor.preserve", 50); // percentage of predictor data to keep when cleaning up

/* session history */
pref("browser.sessionhistory.max_total_viewers", 1);
pref("browser.sessionhistory.max_entries", 50);
pref("browser.sessionhistory.contentViewerTimeout", 360);

// prevent video elements from preloading too much data
pref("media.preload.default", 1); // default to preload none
pref("media.preload.auto", 2);    // preload metadata if preload=auto
pref("media.cache_size", 32768);    // 32MB media cache
// Try to save battery by not resuming reading from a connection until we fall
// below 10s of buffered data.
pref("media.cache_resume_threshold", 10);
pref("media.cache_readahead_limit", 30);

// APZ stuff
pref("apz.content_response_timeout", 600);
pref("apz.allow_immediate_handoff", false);
pref("apz.touch_start_tolerance", "0.06");
pref("apz.axis_lock.breakout_angle", "0.7853982");    // PI / 4 (45 degrees)
// APZ physics settings reviewed by UX
pref("apz.axis_lock.mode", 1); // Use "strict" axis locking
pref("apz.fling_curve_function_x1", "0.59");
pref("apz.fling_curve_function_y1", "0.46");
pref("apz.fling_curve_function_x2", "0.05");
pref("apz.fling_curve_function_y2", "1.00");
pref("apz.fling_curve_threshold_inches_per_ms", "0.01");
// apz.fling_friction and apz.fling_stopped_threshold are currently ignored by Fennec.
pref("apz.fling_friction", "0.004");
pref("apz.fling_stopped_threshold", "0.0");
pref("apz.max_velocity_inches_per_ms", "0.07");
pref("apz.fling_accel_interval_ms", 750);
pref("apz.overscroll.enabled", false);

// Number of video frames we buffer while decoding video.
// On Android this is decided by a similar value which varies for
// each OMX decoder |OMX_PARAM_PORTDEFINITIONTYPE::nBufferCountMin|. This
// number must be less than the OMX equivalent or gecko will think it is
// chronically starved of video frames. All decoders seen so far have a value
// of at least 4.
pref("media.video-queue.default-size", 3);

// Enable MSE
pref("media.mediasource.enabled", true);

// Enable hardware-accelerated Skia canvas
pref("gfx.canvas.azure.backends", "skia");
pref("gfx.canvas.azure.accelerated", true);

pref("javascript.options.baselinejit",      false);
pref("javascript.options.ion",              false);
pref("javascript.options.asmjs",            false);
pref("javascript.options.native_regexp",    false);
