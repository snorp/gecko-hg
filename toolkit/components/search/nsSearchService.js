# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

const Ci = Components.interfaces;
const Cc = Components.classes;
const Cr = Components.results;
const Cu = Components.utils;

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("resource://gre/modules/commonjs/sdk/core/promise.js");

XPCOMUtils.defineLazyModuleGetter(this, "DeferredTask",
  "resource://gre/modules/DeferredTask.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "OS",
  "resource://gre/modules/osfile.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Task",
  "resource://gre/modules/Task.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "TelemetryStopwatch",
  "resource://gre/modules/TelemetryStopwatch.jsm");

// A text encoder to UTF8, used whenever we commit the
// engine metadata to disk.
XPCOMUtils.defineLazyGetter(this, "gEncoder",
                            function() {
                              return new TextEncoder();
                            });

const PERMS_FILE      = 0644;
const PERMS_DIRECTORY = 0755;

const MODE_RDONLY   = 0x01;
const MODE_WRONLY   = 0x02;
const MODE_CREATE   = 0x08;
const MODE_APPEND   = 0x10;
const MODE_TRUNCATE = 0x20;

// Directory service keys
const NS_APP_SEARCH_DIR_LIST  = "SrchPluginsDL";
const NS_APP_USER_SEARCH_DIR  = "UsrSrchPlugns";
const NS_APP_SEARCH_DIR       = "SrchPlugns";
const NS_APP_USER_PROFILE_50_DIR = "ProfD";

// Search engine "locations". If this list is changed, be sure to update
// the engine's _isDefault function accordingly.
const SEARCH_APP_DIR = 1;
const SEARCH_PROFILE_DIR = 2;
const SEARCH_IN_EXTENSION = 3;
const SEARCH_JAR = 4;

// See documentation in nsIBrowserSearchService.idl.
const SEARCH_ENGINE_TOPIC        = "browser-search-engine-modified";
const QUIT_APPLICATION_TOPIC     = "quit-application";

const SEARCH_ENGINE_REMOVED      = "engine-removed";
const SEARCH_ENGINE_ADDED        = "engine-added";
const SEARCH_ENGINE_CHANGED      = "engine-changed";
const SEARCH_ENGINE_LOADED       = "engine-loaded";
const SEARCH_ENGINE_CURRENT      = "engine-current";
const SEARCH_ENGINE_DEFAULT      = "engine-default";

// The following constants are left undocumented in nsIBrowserSearchService.idl
// For the moment, they are meant for testing/debugging purposes only.

/**
 * Topic used for events involving the service itself.
 */
const SEARCH_SERVICE_TOPIC       = "browser-search-service";

/**
 * Sent whenever metadata is fully written to disk.
 */
const SEARCH_SERVICE_METADATA_WRITTEN  = "write-metadata-to-disk-complete";

/**
 * Sent whenever the cache is fully written to disk.
 */
const SEARCH_SERVICE_CACHE_WRITTEN  = "write-cache-to-disk-complete";

const SEARCH_TYPE_MOZSEARCH      = Ci.nsISearchEngine.TYPE_MOZSEARCH;
const SEARCH_TYPE_OPENSEARCH     = Ci.nsISearchEngine.TYPE_OPENSEARCH;
const SEARCH_TYPE_SHERLOCK       = Ci.nsISearchEngine.TYPE_SHERLOCK;

const SEARCH_DATA_XML            = Ci.nsISearchEngine.DATA_XML;
const SEARCH_DATA_TEXT           = Ci.nsISearchEngine.DATA_TEXT;

// Delay for lazy serialization (ms)
const LAZY_SERIALIZE_DELAY = 100;

// Delay for batching invalidation of the JSON cache (ms)
const CACHE_INVALIDATION_DELAY = 1000;

// Current cache version. This should be incremented if the format of the cache
// file is modified.
const CACHE_VERSION = 7;

const ICON_DATAURL_PREFIX = "data:image/x-icon;base64,";

const NEW_LINES = /(\r\n|\r|\n)/;

// Set an arbitrary cap on the maximum icon size. Without this, large icons can
// cause big delays when loading them at startup.
const MAX_ICON_SIZE   = 10000;

// Default charset to use for sending search parameters. ISO-8859-1 is used to
// match previous nsInternetSearchService behavior.
const DEFAULT_QUERY_CHARSET = "ISO-8859-1";

const SEARCH_BUNDLE = "chrome://global/locale/search/search.properties";
const BRAND_BUNDLE = "chrome://branding/locale/brand.properties";

const OPENSEARCH_NS_10  = "http://a9.com/-/spec/opensearch/1.0/";
const OPENSEARCH_NS_11  = "http://a9.com/-/spec/opensearch/1.1/";

// Although the specification at http://opensearch.a9.com/spec/1.1/description/
// gives the namespace names defined above, many existing OpenSearch engines
// are using the following versions.  We therefore allow either.
const OPENSEARCH_NAMESPACES = [
  OPENSEARCH_NS_11, OPENSEARCH_NS_10,
  "http://a9.com/-/spec/opensearchdescription/1.1/",
  "http://a9.com/-/spec/opensearchdescription/1.0/"
];

const OPENSEARCH_LOCALNAME = "OpenSearchDescription";

const MOZSEARCH_NS_10     = "http://www.mozilla.org/2006/browser/search/";
const MOZSEARCH_LOCALNAME = "SearchPlugin";

const URLTYPE_SUGGEST_JSON = "application/x-suggestions+json";
const URLTYPE_SEARCH_HTML  = "text/html";
const URLTYPE_OPENSEARCH   = "application/opensearchdescription+xml";

// Empty base document used to serialize engines to file.
const EMPTY_DOC = "<?xml version=\"1.0\"?>\n" +
                  "<" + MOZSEARCH_LOCALNAME +
                  " xmlns=\"" + MOZSEARCH_NS_10 + "\"" +
                  " xmlns:os=\"" + OPENSEARCH_NS_11 + "\"" +
                  "/>";

const BROWSER_SEARCH_PREF = "browser.search.";

const USER_DEFINED = "{searchTerms}";

// Custom search parameters
#ifdef MOZ_OFFICIAL_BRANDING
const MOZ_OFFICIAL = "official";
#else
const MOZ_OFFICIAL = "unofficial";
#endif
#expand const MOZ_DISTRIBUTION_ID = __MOZ_DISTRIBUTION_ID__;

const MOZ_PARAM_LOCALE         = /\{moz:locale\}/g;
const MOZ_PARAM_DIST_ID        = /\{moz:distributionID\}/g;
const MOZ_PARAM_OFFICIAL       = /\{moz:official\}/g;

// Supported OpenSearch parameters
// See http://opensearch.a9.com/spec/1.1/querysyntax/#core
const OS_PARAM_USER_DEFINED    = /\{searchTerms\??\}/g;
const OS_PARAM_INPUT_ENCODING  = /\{inputEncoding\??\}/g;
const OS_PARAM_LANGUAGE        = /\{language\??\}/g;
const OS_PARAM_OUTPUT_ENCODING = /\{outputEncoding\??\}/g;

// Default values
const OS_PARAM_LANGUAGE_DEF         = "*";
const OS_PARAM_OUTPUT_ENCODING_DEF  = "UTF-8";
const OS_PARAM_INPUT_ENCODING_DEF   = "UTF-8";

// "Unsupported" OpenSearch parameters. For example, we don't support
// page-based results, so if the engine requires that we send the "page index"
// parameter, we'll always send "1".
const OS_PARAM_COUNT        = /\{count\??\}/g;
const OS_PARAM_START_INDEX  = /\{startIndex\??\}/g;
const OS_PARAM_START_PAGE   = /\{startPage\??\}/g;

// Default values
const OS_PARAM_COUNT_DEF        = "20"; // 20 results
const OS_PARAM_START_INDEX_DEF  = "1";  // start at 1st result
const OS_PARAM_START_PAGE_DEF   = "1";  // 1st page

// Optional parameter
const OS_PARAM_OPTIONAL     = /\{(?:\w+:)?\w+\?\}/g;

// A array of arrays containing parameters that we don't fully support, and
// their default values. We will only send values for these parameters if
// required, since our values are just really arbitrary "guesses" that should
// give us the output we want.
var OS_UNSUPPORTED_PARAMS = [
  [OS_PARAM_COUNT, OS_PARAM_COUNT_DEF],
  [OS_PARAM_START_INDEX, OS_PARAM_START_INDEX_DEF],
  [OS_PARAM_START_PAGE, OS_PARAM_START_PAGE_DEF],
];

// The default engine update interval, in days. This is only used if an engine
// specifies an updateURL, but not an updateInterval.
const SEARCH_DEFAULT_UPDATE_INTERVAL = 7;

// Returns false for whitespace-only or commented out lines in a
// Sherlock file, true otherwise.
function isUsefulLine(aLine) {
  return !(/^\s*($|#)/i.test(aLine));
}

this.__defineGetter__("FileUtils", function() {
  delete this.FileUtils;
  Components.utils.import("resource://gre/modules/FileUtils.jsm");
  return FileUtils;
});

this.__defineGetter__("NetUtil", function() {
  delete this.NetUtil;
  Components.utils.import("resource://gre/modules/NetUtil.jsm");
  return NetUtil;
});

this.__defineGetter__("gChromeReg", function() {
  delete this.gChromeReg;
  return this.gChromeReg = Cc["@mozilla.org/chrome/chrome-registry;1"].
                           getService(Ci.nsIChromeRegistry);
});

/**
 * Prefixed to all search debug output.
 */
const SEARCH_LOG_PREFIX = "*** Search: ";

/**
 * Outputs aText to the JavaScript console as well as to stdout.
 */
function DO_LOG(aText) {
  dump(SEARCH_LOG_PREFIX + aText + "\n");
  Services.console.logStringMessage(aText);
}

#ifdef DEBUG
/**
 * In debug builds, use a live, pref-based (browser.search.log) LOG function
 * to allow enabling/disabling without a restart.
 */
function PREF_LOG(aText) {
  if (getBoolPref(BROWSER_SEARCH_PREF + "log", false))
    DO_LOG(aText);
}
var LOG = PREF_LOG;

#else

/**
 * Otherwise, don't log at all by default. This can be overridden at startup
 * by the pref, see SearchService's _init method.
 */
var LOG = function(){};

#endif

/**
 * Presents an assertion dialog in non-release builds and throws.
 * @param  message
 *         A message to display
 * @param  resultCode
 *         The NS_ERROR_* value to throw.
 * @throws resultCode
 */
function ERROR(message, resultCode) {
  NS_ASSERT(false, SEARCH_LOG_PREFIX + message);
  throw Components.Exception(message, resultCode);
}

/**
 * Logs the failure message (if browser.search.log is enabled) and throws.
 * @param  message
 *         A message to display
 * @param  resultCode
 *         The NS_ERROR_* value to throw.
 * @throws resultCode or NS_ERROR_INVALID_ARG if resultCode isn't specified.
 */
function FAIL(message, resultCode) {
  LOG(message);
  throw Components.Exception(message, resultCode || Cr.NS_ERROR_INVALID_ARG);
}

/**
 * Truncates big blobs of (data-)URIs to console-friendly sizes
 * @param str
 *        String to tone down
 * @param len
 *        Maximum length of the string to return. Defaults to the length of a tweet.
 */
function limitURILength(str, len) {
  len = len || 140;
  if (str.length > len)
    return str.slice(0, len) + "...";
  return str;
}

/**
 * Utilities for dealing with promises and Task.jsm
 */
const TaskUtils = {
  /**
   * Add logging to a promise.
   *
   * @param {Promise} promise
   * @return {Promise} A promise behaving as |promise|, but with additional
   * logging in case of uncaught error.
   */
  captureErrors: function captureErrors(promise) {
    return promise.then(
      null,
      function onError(reason) {
        LOG("Uncaught asynchronous error: " + reason + " at\n" + reason.stack);
        throw reason;
      }
    );
  },
  /**
   * Spawn a new Task from a generator.
   *
   * This function behaves as |Task.spawn|, with the exception that it
   * adds logging in case of uncaught error. For more information, see
   * the documentation of |Task.jsm|.
   *
   * @param {generator} gen Some generator.
   * @return {Promise} A promise built from |gen|, with the same semantics
   * as |Task.spawn(gen)|.
   */
  spawn: function spawn(gen) {
    return this.captureErrors(Task.spawn(gen));
  },
  /**
   * Execute a mozIStorage statement asynchronously, wrapping the
   * result in a promise.
   *
   * @param {mozIStorageStaement} statement A statement to be executed
   * asynchronously. The semantics are the same as these of |statement.execute|.
   * @param {function*} onResult A callback, called for each successive result.
   *
   * @return {Promise} A promise, resolved successfully if |statement.execute|
   * succeeds, rejected if it fails.
   */
  executeStatement: function executeStatement(statement, onResult) {
    let deferred = Promise.defer();
    onResult = onResult || function() {};
    statement.executeAsync({
      handleResult: onResult,
      handleError: function handleError(aError) {
        deferred.reject(aError);
      },
      handleCompletion: function handleCompletion(aReason) {
        statement.finalize();
        // Note that, in case of error, deferred.reject(aError)
        // has already been called by this point, so the call to
        // |deferred.resolve| is simply ignored.
        deferred.resolve(aReason);
      }
    });
    return deferred.promise;
  }
};

/**
 * Ensures an assertion is met before continuing. Should be used to indicate
 * fatal errors.
 * @param  assertion
 *         An assertion that must be met
 * @param  message
 *         A message to display if the assertion is not met
 * @param  resultCode
 *         The NS_ERROR_* value to throw if the assertion is not met
 * @throws resultCode
 */
function ENSURE_WARN(assertion, message, resultCode) {
  NS_ASSERT(assertion, SEARCH_LOG_PREFIX + message);
  if (!assertion)
    throw Components.Exception(message, resultCode);
}

function loadListener(aChannel, aEngine, aCallback) {
  this._channel = aChannel;
  this._bytes = [];
  this._engine = aEngine;
  this._callback = aCallback;
}
loadListener.prototype = {
  _callback: null,
  _channel: null,
  _countRead: 0,
  _engine: null,
  _stream: null,

  QueryInterface: function SRCH_loadQI(aIID) {
    if (aIID.equals(Ci.nsISupports)           ||
        aIID.equals(Ci.nsIRequestObserver)    ||
        aIID.equals(Ci.nsIStreamListener)     ||
        aIID.equals(Ci.nsIChannelEventSink)   ||
        aIID.equals(Ci.nsIInterfaceRequestor) ||
        // See FIXME comment below
        aIID.equals(Ci.nsIHttpEventSink)      ||
        aIID.equals(Ci.nsIProgressEventSink)  ||
        false)
      return this;

    throw Cr.NS_ERROR_NO_INTERFACE;
  },

  // nsIRequestObserver
  onStartRequest: function SRCH_loadStartR(aRequest, aContext) {
    LOG("loadListener: Starting request: " + aRequest.name);
    this._stream = Cc["@mozilla.org/binaryinputstream;1"].
                   createInstance(Ci.nsIBinaryInputStream);
  },

  onStopRequest: function SRCH_loadStopR(aRequest, aContext, aStatusCode) {
    LOG("loadListener: Stopping request: " + aRequest.name);

    var requestFailed = !Components.isSuccessCode(aStatusCode);
    if (!requestFailed && (aRequest instanceof Ci.nsIHttpChannel))
      requestFailed = !aRequest.requestSucceeded;

    if (requestFailed || this._countRead == 0) {
      LOG("loadListener: request failed!");
      // send null so the callback can deal with the failure
      this._callback(null, this._engine);
    } else
      this._callback(this._bytes, this._engine);
    this._channel = null;
    this._engine  = null;
  },

  // nsIStreamListener
  onDataAvailable: function SRCH_loadDAvailable(aRequest, aContext,
                                                aInputStream, aOffset,
                                                aCount) {
    this._stream.setInputStream(aInputStream);

    // Get a byte array of the data
    this._bytes = this._bytes.concat(this._stream.readByteArray(aCount));
    this._countRead += aCount;
  },

  // nsIChannelEventSink
  asyncOnChannelRedirect: function SRCH_loadCRedirect(aOldChannel, aNewChannel,
                                                      aFlags, callback) {
    this._channel = aNewChannel;
    callback.onRedirectVerifyCallback(Components.results.NS_OK);
  },

  // nsIInterfaceRequestor
  getInterface: function SRCH_load_GI(aIID) {
    return this.QueryInterface(aIID);
  },

  // FIXME: bug 253127
  // nsIHttpEventSink
  onRedirect: function (aChannel, aNewChannel) {},
  // nsIProgressEventSink
  onProgress: function (aRequest, aContext, aProgress, aProgressMax) {},
  onStatus: function (aRequest, aContext, aStatus, aStatusArg) {}
}


/**
 * Used to verify a given DOM node's localName and namespaceURI.
 * @param aElement
 *        The element to verify.
 * @param aLocalNameArray
 *        An array of strings to compare against aElement's localName.
 * @param aNameSpaceArray
 *        An array of strings to compare against aElement's namespaceURI.
 *
 * @returns false if aElement is null, or if its localName or namespaceURI
 *          does not match one of the elements in the aLocalNameArray or
 *          aNameSpaceArray arrays, respectively.
 * @throws NS_ERROR_INVALID_ARG if aLocalNameArray or aNameSpaceArray are null.
 */
function checkNameSpace(aElement, aLocalNameArray, aNameSpaceArray) {
  if (!aLocalNameArray || !aNameSpaceArray)
    FAIL("missing aLocalNameArray or aNameSpaceArray for checkNameSpace");
  return (aElement                                                &&
          (aLocalNameArray.indexOf(aElement.localName)    != -1)  &&
          (aNameSpaceArray.indexOf(aElement.namespaceURI) != -1));
}

/**
 * Safely close a nsISafeOutputStream.
 * @param aFOS
 *        The file output stream to close.
 */
function closeSafeOutputStream(aFOS) {
  if (aFOS instanceof Ci.nsISafeOutputStream) {
    try {
      aFOS.finish();
      return;
    } catch (e) { }
  }
  aFOS.close();
}

/**
 * Wrapper function for nsIIOService::newURI.
 * @param aURLSpec
 *        The URL string from which to create an nsIURI.
 * @returns an nsIURI object, or null if the creation of the URI failed.
 */
function makeURI(aURLSpec, aCharset) {
  try {
    return NetUtil.newURI(aURLSpec, aCharset);
  } catch (ex) { }

  return null;
}

/**
 * Gets a directory from the directory service.
 * @param aKey
 *        The directory service key indicating the directory to get.
 */
function getDir(aKey, aIFace) {
  if (!aKey)
    FAIL("getDir requires a directory key!");

  return Services.dirsvc.get(aKey, aIFace || Ci.nsIFile);
}

/**
 * The following two functions are essentially copied from
 * nsInternetSearchService. They are required for backwards compatibility.
 */
function queryCharsetFromCode(aCode) {
  const codes = [];
  codes[0] = "macintosh";
  codes[6] = "x-mac-greek";
  codes[35] = "x-mac-turkish";
  codes[513] = "ISO-8859-1";
  codes[514] = "ISO-8859-2";
  codes[517] = "ISO-8859-5";
  codes[518] = "ISO-8859-6";
  codes[519] = "ISO-8859-7";
  codes[520] = "ISO-8859-8";
  codes[521] = "ISO-8859-9";
  codes[1280] = "windows-1252";
  codes[1281] = "windows-1250";
  codes[1282] = "windows-1251";
  codes[1283] = "windows-1253";
  codes[1284] = "windows-1254";
  codes[1285] = "windows-1255";
  codes[1286] = "windows-1256";
  codes[1536] = "us-ascii";
  codes[1584] = "GB2312";
  codes[1585] = "gbk";
  codes[1600] = "EUC-KR";
  codes[2080] = "ISO-2022-JP";
  codes[2096] = "ISO-2022-CN";
  codes[2112] = "ISO-2022-KR";
  codes[2336] = "EUC-JP";
  codes[2352] = "GB2312";
  codes[2353] = "x-euc-tw";
  codes[2368] = "EUC-KR";
  codes[2561] = "Shift_JIS";
  codes[2562] = "KOI8-R";
  codes[2563] = "Big5";
  codes[2565] = "HZ-GB-2312";

  if (codes[aCode])
    return codes[aCode];

  // Don't bother being fancy about what to return in the failure case.
  return "windows-1252";
}
function fileCharsetFromCode(aCode) {
  const codes = [
    "macintosh",             // 0
    "Shift_JIS",             // 1
    "Big5",                  // 2
    "EUC-KR",                // 3
    "X-MAC-ARABIC",          // 4
    "X-MAC-HEBREW",          // 5
    "X-MAC-GREEK",           // 6
    "X-MAC-CYRILLIC",        // 7
    "X-MAC-DEVANAGARI" ,     // 9
    "X-MAC-GURMUKHI",        // 10
    "X-MAC-GUJARATI",        // 11
    "X-MAC-ORIYA",           // 12
    "X-MAC-BENGALI",         // 13
    "X-MAC-TAMIL",           // 14
    "X-MAC-TELUGU",          // 15
    "X-MAC-KANNADA",         // 16
    "X-MAC-MALAYALAM",       // 17
    "X-MAC-SINHALESE",       // 18
    "X-MAC-BURMESE",         // 19
    "X-MAC-KHMER",           // 20
    "X-MAC-THAI",            // 21
    "X-MAC-LAOTIAN",         // 22
    "X-MAC-GEORGIAN",        // 23
    "X-MAC-ARMENIAN",        // 24
    "GB2312",                // 25
    "X-MAC-TIBETAN",         // 26
    "X-MAC-MONGOLIAN",       // 27
    "X-MAC-ETHIOPIC",        // 28
    "X-MAC-CENTRALEURROMAN", // 29
    "X-MAC-VIETNAMESE",      // 30
    "X-MAC-EXTARABIC"        // 31
  ];
  // Sherlock files have always defaulted to macintosh, so do that here too
  return codes[aCode] || codes[0];
}

/**
 * Returns a string interpretation of aBytes using aCharset, or null on
 * failure.
 */
function bytesToString(aBytes, aCharset) {
  var converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"].
                  createInstance(Ci.nsIScriptableUnicodeConverter);
  LOG("bytesToString: converting using charset: " + aCharset);

  try {
    converter.charset = aCharset;
    return converter.convertFromByteArray(aBytes, aBytes.length);
  } catch (ex) {}

  return null;
}

/**
 * Converts an array of bytes representing a Sherlock file into an array of
 * lines representing the useful data from the file.
 *
 * @param aBytes
 *        The array of bytes representing the Sherlock file.
 * @param aCharsetCode
 *        An integer value representing a character set code to be passed to
 *        fileCharsetFromCode, or null for the default Sherlock encoding.
 */
function sherlockBytesToLines(aBytes, aCharsetCode) {
  // fileCharsetFromCode returns the default encoding if aCharsetCode is null
  var charset = fileCharsetFromCode(aCharsetCode);

  var dataString = bytesToString(aBytes, charset);
  if (!dataString)
    FAIL("sherlockBytesToLines: Couldn't convert byte array!", Cr.NS_ERROR_FAILURE);

  // Split the string into lines, and filter out comments and
  // whitespace-only lines
  return dataString.split(NEW_LINES).filter(isUsefulLine);
}

/**
 * Gets the current value of the locale.  It's possible for this preference to
 * be localized, so we have to do a little extra work here.  Similar code
 * exists in nsHttpHandler.cpp when building the UA string.
 */
function getLocale() {
  const localePref = "general.useragent.locale";
  var locale = getLocalizedPref(localePref);
  if (locale)
    return locale;

  // Not localized
  return Services.prefs.getCharPref(localePref);
}

/**
 * Wrapper for nsIPrefBranch::getComplexValue.
 * @param aPrefName
 *        The name of the pref to get.
 * @returns aDefault if the requested pref doesn't exist.
 */
function getLocalizedPref(aPrefName, aDefault) {
  const nsIPLS = Ci.nsIPrefLocalizedString;
  try {
    return Services.prefs.getComplexValue(aPrefName, nsIPLS).data;
  } catch (ex) {}

  return aDefault;
}

/**
 * Wrapper for nsIPrefBranch::setComplexValue.
 * @param aPrefName
 *        The name of the pref to set.
 */
function setLocalizedPref(aPrefName, aValue) {
  const nsIPLS = Ci.nsIPrefLocalizedString;
  try {
    var pls = Components.classes["@mozilla.org/pref-localizedstring;1"]
                        .createInstance(Ci.nsIPrefLocalizedString);
    pls.data = aValue;
    Services.prefs.setComplexValue(aPrefName, nsIPLS, pls);
  } catch (ex) {}
}

/**
 * Wrapper for nsIPrefBranch::getBoolPref.
 * @param aPrefName
 *        The name of the pref to get.
 * @returns aDefault if the requested pref doesn't exist.
 */
function getBoolPref(aName, aDefault) {
  try {
    return Services.prefs.getBoolPref(aName);
  } catch (ex) {
    return aDefault;
  }
}

/**
 * Get a unique nsIFile object with a sanitized name, based on the engine name.
 * @param aName
 *        A name to "sanitize". Can be an empty string, in which case a random
 *        8 character filename will be produced.
 * @returns A nsIFile object in the user's search engines directory with a
 *          unique sanitized name.
 */
function getSanitizedFile(aName) {
  var fileName = sanitizeName(aName) + ".xml";
  var file = getDir(NS_APP_USER_SEARCH_DIR);
  file.append(fileName);
  file.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, PERMS_FILE);
  return file;
}

/**
 * @return a sanitized name to be used as a filename, or a random name
 *         if a sanitized name cannot be obtained (if aName contains
 *         no valid characters).
 */
function sanitizeName(aName) {
  const maxLength = 60;
  const minLength = 1;
  var name = aName.toLowerCase();
  name = name.replace(/\s+/g, "-");
  name = name.replace(/[^-a-z0-9]/g, "");

  // Use a random name if our input had no valid characters.
  if (name.length < minLength)
    name = Math.random().toString(36).replace(/^.*\./, '');

  // Force max length.
  return name.substring(0, maxLength);
}

/**
 * Retrieve a pref from the search param branch.
 *
 * @param prefName
 *        The name of the pref.
 **/
function getMozParamPref(prefName)
  Services.prefs.getCharPref(BROWSER_SEARCH_PREF + "param." + prefName);

/**
 * Notifies watchers of SEARCH_ENGINE_TOPIC about changes to an engine or to
 * the state of the search service.
 *
 * @param aEngine
 *        The nsISearchEngine object to which the change applies.
 * @param aVerb
 *        A verb describing the change.
 *
 * @see nsIBrowserSearchService.idl
 */
let gInitialized = false;
function notifyAction(aEngine, aVerb) {
  if (gInitialized) {
    LOG("NOTIFY: Engine: \"" + aEngine.name + "\"; Verb: \"" + aVerb + "\"");
    Services.obs.notifyObservers(aEngine, SEARCH_ENGINE_TOPIC, aVerb);
  }
}

function  parseJsonFromStream(aInputStream) {
  const json = Cc["@mozilla.org/dom/json;1"].createInstance(Ci.nsIJSON);
  const data = json.decodeFromStream(aInputStream, aInputStream.available());
  return data;
}

/**
 * Simple object representing a name/value pair.
 */
function QueryParameter(aName, aValue, aPurpose) {
  if (!aName || (aValue == null))
    FAIL("missing name or value for QueryParameter!");

  this.name = aName;
  this.value = aValue;
  this.purpose = aPurpose;
}

/**
 * Perform OpenSearch parameter substitution on aParamValue.
 *
 * @param aParamValue
 *        A string containing OpenSearch search parameters.
 * @param aSearchTerms
 *        The user-provided search terms. This string will inserted into
 *        aParamValue as the value of the OS_PARAM_USER_DEFINED parameter.
 *        This value must already be escaped appropriately - it is inserted
 *        as-is.
 * @param aEngine
 *        The engine which owns the string being acted on.
 *
 * @see http://opensearch.a9.com/spec/1.1/querysyntax/#core
 */
function ParamSubstitution(aParamValue, aSearchTerms, aEngine) {
  var value = aParamValue;

  var distributionID = MOZ_DISTRIBUTION_ID;
  try {
    distributionID = Services.prefs.getCharPref(BROWSER_SEARCH_PREF + "distributionID");
  }
  catch (ex) { }
  var official = MOZ_OFFICIAL;
  try {
    if (Services.prefs.getBoolPref(BROWSER_SEARCH_PREF + "official"))
      official = "official";
    else
      official = "unofficial";
  }
  catch (ex) { }

  // Custom search parameters. These are only available to default search
  // engines.
  if (aEngine._isDefault) {
    value = value.replace(MOZ_PARAM_LOCALE, getLocale());
    value = value.replace(MOZ_PARAM_DIST_ID, distributionID);
    value = value.replace(MOZ_PARAM_OFFICIAL, official);
  }

  // Insert the OpenSearch parameters we're confident about
  value = value.replace(OS_PARAM_USER_DEFINED, aSearchTerms);
  value = value.replace(OS_PARAM_INPUT_ENCODING, aEngine.queryCharset);
  value = value.replace(OS_PARAM_LANGUAGE,
                        getLocale() || OS_PARAM_LANGUAGE_DEF);
  value = value.replace(OS_PARAM_OUTPUT_ENCODING,
                        OS_PARAM_OUTPUT_ENCODING_DEF);

  // Replace any optional parameters
  value = value.replace(OS_PARAM_OPTIONAL, "");

  // Insert any remaining required params with our default values
  for (var i = 0; i < OS_UNSUPPORTED_PARAMS.length; ++i) {
    value = value.replace(OS_UNSUPPORTED_PARAMS[i][0],
                          OS_UNSUPPORTED_PARAMS[i][1]);
  }

  return value;
}

/**
 * Creates an engineURL object, which holds the query URL and all parameters.
 *
 * @param aType
 *        A string containing the name of the MIME type of the search results
 *        returned by this URL.
 * @param aMethod
 *        The HTTP request method. Must be a case insensitive value of either
 *        "GET" or "POST".
 * @param aTemplate
 *        The URL to which search queries should be sent. For GET requests,
 *        must contain the string "{searchTerms}", to indicate where the user
 *        entered search terms should be inserted.
 *
 * @see http://opensearch.a9.com/spec/1.1/querysyntax/#urltag
 *
 * @throws NS_ERROR_NOT_IMPLEMENTED if aType is unsupported.
 */
function EngineURL(aType, aMethod, aTemplate) {
  if (!aType || !aMethod || !aTemplate)
    FAIL("missing type, method or template for EngineURL!");

  var method = aMethod.toUpperCase();
  var type   = aType.toLowerCase();

  if (method != "GET" && method != "POST")
    FAIL("method passed to EngineURL must be \"GET\" or \"POST\"");

  this.type     = type;
  this.method   = method;
  this.params   = [];
  this.rels     = [];
  // Don't serialize expanded mozparams
  this.mozparams = {};

  var templateURI = makeURI(aTemplate);
  if (!templateURI)
    FAIL("new EngineURL: template is not a valid URI!", Cr.NS_ERROR_FAILURE);

  switch (templateURI.scheme) {
    case "http":
    case "https":
    // Disable these for now, see bug 295018
    // case "file":
    // case "resource":
      this.template = aTemplate;
      break;
    default:
      FAIL("new EngineURL: template uses invalid scheme!", Cr.NS_ERROR_FAILURE);
  }
}
EngineURL.prototype = {

  addParam: function SRCH_EURL_addParam(aName, aValue, aPurpose) {
    this.params.push(new QueryParameter(aName, aValue, aPurpose));
  },

  // Note: This method requires that aObj has a unique name or the previous MozParams entry with
  // that name will be overwritten.
  _addMozParam: function SRCH_EURL__addMozParam(aObj) {
    aObj.mozparam = true;
    this.mozparams[aObj.name] = aObj;
  },

  reevalMozParams: function(engine) {
    for (let param of this.params) {
      let mozparam = this.mozparams[param.name];
      if (mozparam && mozparam.positionDependent) {
        // the condition is a string in the form of "topN", extract N as int
        let positionStr = mozparam.condition.slice("top".length);
        let position = parseInt(positionStr, 10);
        let engines;
        try {
          // This will throw if we're not initialized yet (which shouldn't happen), just 
          // ignore and move on with the false Value (checking isInitialized also throws)
          // XXX
          engines = Services.search.getVisibleEngines({});
        } catch (ex) {
          LOG("reevalMozParams called before search service initialization!?");
          break;
        }
        let index = engines.map((e) => e.wrappedJSObject).indexOf(engine.wrappedJSObject);
        let isTopN = index > -1 && (index + 1) <= position;
        param.value = isTopN ? mozparam.trueValue : mozparam.falseValue;
      }
    }
  },

  getSubmission: function SRCH_EURL_getSubmission(aSearchTerms, aEngine, aPurpose) {
    this.reevalMozParams(aEngine);

    var url = ParamSubstitution(this.template, aSearchTerms, aEngine);
    // Default to an empty string if the purpose is not provided so that default purpose params
    // (purpose="") work consistently rather than having to define "null" and "" purposes.
    var purpose = aPurpose || "";

    // Create an application/x-www-form-urlencoded representation of our params
    // (name=value&name=value&name=value)
    var dataString = "";
    for (var i = 0; i < this.params.length; ++i) {
      var param = this.params[i];

      // If this parameter has a purpose, only add it if the purpose matches
      if (param.purpose !== undefined && param.purpose != purpose)
        continue;

      var value = ParamSubstitution(param.value, aSearchTerms, aEngine);

      dataString += (i > 0 ? "&" : "") + param.name + "=" + value;
    }

    var postData = null;
    if (this.method == "GET") {
      // GET method requests have no post data, and append the encoded
      // query string to the url...
      if (url.indexOf("?") == -1 && dataString)
        url += "?";
      url += dataString;
    } else if (this.method == "POST") {
      // POST method requests must wrap the encoded text in a MIME
      // stream and supply that as POSTDATA.
      var stringStream = Cc["@mozilla.org/io/string-input-stream;1"].
                         createInstance(Ci.nsIStringInputStream);
      stringStream.data = dataString;

      postData = Cc["@mozilla.org/network/mime-input-stream;1"].
                 createInstance(Ci.nsIMIMEInputStream);
      postData.addHeader("Content-Type", "application/x-www-form-urlencoded");
      postData.addContentLength = true;
      postData.setData(stringStream);
    }

    return new Submission(makeURI(url), postData);
  },

  _hasRelation: function SRC_EURL__hasRelation(aRel)
    this.rels.some(function(e) e == aRel.toLowerCase()),

  _initWithJSON: function SRC_EURL__initWithJSON(aJson, aEngine) {
    if (!aJson.params)
      return;

    this.rels = aJson.rels;

    for (let i = 0; i < aJson.params.length; ++i) {
      let param = aJson.params[i];
      if (param.mozparam) {
        if (param.condition == "defaultEngine") {
          if (aEngine._isDefaultEngine())
            this.addParam(param.name, param.trueValue);
          else
            this.addParam(param.name, param.falseValue);
        } else if (param.condition == "pref") {
          let value = getMozParamPref(param.pref);
          this.addParam(param.name, value);
        }
        this._addMozParam(param);
      }
      else
        this.addParam(param.name, param.value, param.purpose);
    }
  },

  /**
   * Creates a JavaScript object that represents this URL.
   * @returns An object suitable for serialization as JSON.
   **/
  _serializeToJSON: function SRCH_EURL__serializeToJSON() {
    var json = {
      template: this.template,
      rels: this.rels
    };

    if (this.type != URLTYPE_SEARCH_HTML)
      json.type = this.type;
    if (this.method != "GET")
      json.method = this.method;

    function collapseMozParams(aParam)
      this.mozparams[aParam.name] || aParam;
    json.params = this.params.map(collapseMozParams, this);

    return json;
  },

  /**
   * Serializes the engine object to a OpenSearch Url element.
   * @param aDoc
   *        The document to use to create the Url element.
   * @param aElement
   *        The element to which the created Url element is appended.
   *
   * @see http://opensearch.a9.com/spec/1.1/querysyntax/#urltag
   */
  _serializeToElement: function SRCH_EURL_serializeToEl(aDoc, aElement) {
    var url = aDoc.createElementNS(OPENSEARCH_NS_11, "Url");
    url.setAttribute("type", this.type);
    url.setAttribute("method", this.method);
    url.setAttribute("template", this.template);
    if (this.rels.length)
      url.setAttribute("rel", this.rels.join(" "));

    for (var i = 0; i < this.params.length; ++i) {
      var param = aDoc.createElementNS(OPENSEARCH_NS_11, "Param");
      param.setAttribute("name", this.params[i].name);
      param.setAttribute("value", this.params[i].value);
      url.appendChild(aDoc.createTextNode("\n  "));
      url.appendChild(param);
    }
    url.appendChild(aDoc.createTextNode("\n"));
    aElement.appendChild(url);
  }
};

/**
 * nsISearchEngine constructor.
 * @param aLocation
 *        A nsILocalFile or nsIURI object representing the location of the
 *        search engine data file.
 * @param aSourceDataType
 *        The data type of the file used to describe the engine. Must be either
 *        DATA_XML or DATA_TEXT.
 * @param aIsReadOnly
 *        Boolean indicating whether the engine should be treated as read-only.
 *        Read only engines cannot be serialized to file.
 */
function Engine(aLocation, aSourceDataType, aIsReadOnly) {
  this._dataType = aSourceDataType;
  this._readOnly = aIsReadOnly;
  this._urls = [];

  if (aLocation.type) {
    if (aLocation.type == "filePath")
      this._file = aLocation.value;
    else if (aLocation.type == "uri")
      this._uri = aLocation.value;
  } else if (aLocation instanceof Ci.nsILocalFile) {
    // we already have a file (e.g. loading engines from disk)
    this._file = aLocation;
  } else if (aLocation instanceof Ci.nsIURI) {
    switch (aLocation.scheme) {
      case "https":
      case "http":
      case "ftp":
      case "data":
      case "file":
      case "resource":
      case "chrome":
        this._uri = aLocation;
        break;
      default:
        ERROR("Invalid URI passed to the nsISearchEngine constructor",
              Cr.NS_ERROR_INVALID_ARG);
    }
  } else
    ERROR("Engine location is neither a File nor a URI object",
          Cr.NS_ERROR_INVALID_ARG);
}

Engine.prototype = {
  // The engine's alias (can be null). Initialized to |undefined| to indicate
  // not-initialized-from-engineMetadataService.
  _alias: undefined,
  // A distribution-unique identifier for the engine. Either null or set
  // when loaded. See getter.
  _identifier: undefined,
  // The data describing the engine. Is either an array of bytes, for Sherlock
  // files, or an XML document element, for XML plugins.
  _data: null,
  // The engine's data type. See data types (DATA_) defined above.
  _dataType: null,
  // Whether or not the engine is readonly.
  _readOnly: true,
  // The engine's description
  _description: "",
  // Used to store the engine to replace, if we're an update to an existing
  // engine.
  _engineToUpdate: null,
  // The file from which the plugin was loaded.
  __file: null,
  get _file() {
    if (this.__file && !(this.__file instanceof Ci.nsILocalFile)) {
      let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
      file.persistentDescriptor = this.__file;
      return this.__file = file;
    }
    return this.__file;
  },
  set _file(aValue) {
    this.__file = aValue;
  },
  // Set to true if the engine has a preferred icon (an icon that should not be
  // overridden by a non-preferred icon).
  _hasPreferredIcon: null,
  // Whether the engine is hidden from the user.
  _hidden: null,
  // The engine's name.
  _name: null,
  // The engine type. See engine types (TYPE_) defined above.
  _type: null,
  // The name of the charset used to submit the search terms.
  _queryCharset: null,
  // A URL string pointing to the engine's search form.
  __searchForm: null,
  get _searchForm() {
    return this.__searchForm;
  },
  set _searchForm(aValue) {
    if (/^https?:/i.test(aValue))
      this.__searchForm = aValue;
    else
      LOG("_searchForm: Invalid URL dropped for " + this._name ||
          "the current engine");
  },
  // The URI object from which the engine was retrieved.
  // This is null for engines loaded from disk, but present for engines loaded
  // from chrome:// URIs.
  __uri: null,
  get _uri() {
    if (this.__uri && !(this.__uri instanceof Ci.nsIURI))
      this.__uri = makeURI(this.__uri);

    return this.__uri;
  },
  set _uri(aValue) {
    this.__uri = aValue;
  },
  // Whether to obtain user confirmation before adding the engine. This is only
  // used when the engine is first added to the list.
  _confirm: false,
  // Whether to set this as the current engine as soon as it is loaded.  This
  // is only used when the engine is first added to the list.
  _useNow: false,
  // A function to be invoked when this engine object's addition completes (or
  // fails). Only used for installation via addEngine.
  _installCallback: null,
  // Where the engine was loaded from. Can be one of: SEARCH_APP_DIR,
  // SEARCH_PROFILE_DIR, SEARCH_IN_EXTENSION.
  __installLocation: null,
  // The number of days between update checks for new versions
  _updateInterval: null,
  // The url to check at for a new update
  _updateURL: null,
  // The url to check for a new icon
  _iconUpdateURL: null,
  /* Deferred serialization task. */
  _lazySerializeTask: null,

  /**
   * Retrieves the data from the engine's file. If the engine's dataType is
   * XML, the document element is placed in the engine's data field. For text
   * engines, the data is just read directly from file and placed as an array
   * of lines in the engine's data field.
   */
  _initFromFile: function SRCH_ENG_initFromFile() {
    if (!this._file || !this._file.exists())
      FAIL("File must exist before calling initFromFile!", Cr.NS_ERROR_UNEXPECTED);

    var fileInStream = Cc["@mozilla.org/network/file-input-stream;1"].
                       createInstance(Ci.nsIFileInputStream);

    fileInStream.init(this._file, MODE_RDONLY, PERMS_FILE, false);

    if (this._dataType == SEARCH_DATA_XML) {
      var domParser = Cc["@mozilla.org/xmlextras/domparser;1"].
                      createInstance(Ci.nsIDOMParser);
      var doc = domParser.parseFromStream(fileInStream, "UTF-8",
                                          this._file.fileSize,
                                          "text/xml");

      this._data = doc.documentElement;
    } else {
      ERROR("Unsuppored engine _dataType in _initFromFile: \"" +
            this._dataType + "\"",
            Cr.NS_ERROR_UNEXPECTED);
    }
    fileInStream.close();

    // Now that the data is loaded, initialize the engine object
    this._initFromData();
  },

  /**
   * Retrieves the data from the engine's file asynchronously. If the engine's
   * dataType is XML, the document element is placed in the engine's data field.
   *
   * @returns {Promise} A promise, resolved successfully if initializing from
   * data succeeds, rejected if it fails.
   */
  _asyncInitFromFile: function SRCH_ENG__asyncInitFromFile() {
    return TaskUtils.spawn(function() {
      if (!this._file || !(yield OS.File.exists(this._file.path)))
        FAIL("File must exist before calling initFromFile!", Cr.NS_ERROR_UNEXPECTED);

      if (this._dataType == SEARCH_DATA_XML) {
        let fileURI = NetUtil.ioService.newFileURI(this._file);
        yield this._retrieveSearchXMLData(fileURI.spec);
      } else {
        ERROR("Unsuppored engine _dataType in _initFromFile: \"" +
              this._dataType + "\"",
              Cr.NS_ERROR_UNEXPECTED);
      }

      // Now that the data is loaded, initialize the engine object
      this._initFromData();
    }.bind(this));
  },

  /**
   * Retrieves the engine data from a URI. Initializes the engine, flushes to
   * disk, and notifies the search service once initialization is complete.
   */
  _initFromURIAndLoad: function SRCH_ENG_initFromURIAndLoad() {
    ENSURE_WARN(this._uri instanceof Ci.nsIURI,
                "Must have URI when calling _initFromURIAndLoad!",
                Cr.NS_ERROR_UNEXPECTED);

    LOG("_initFromURIAndLoad: Downloading engine from: \"" + this._uri.spec + "\".");

    var chan = NetUtil.ioService.newChannelFromURI(this._uri);

    if (this._engineToUpdate && (chan instanceof Ci.nsIHttpChannel)) {
      var lastModified = engineMetadataService.getAttr(this._engineToUpdate,
                                                       "updatelastmodified");
      if (lastModified)
        chan.setRequestHeader("If-Modified-Since", lastModified, false);
    }
    var listener = new loadListener(chan, this, this._onLoad);
    chan.notificationCallbacks = listener;
    chan.asyncOpen(listener, null);
  },

  /**
   * Retrieves the engine data from a URI asynchronously and initializes it.
   *
   * @returns {Promise} A promise, resolved successfully if retrieveing data
   * succeeds.
   */
  _asyncInitFromURI: function SRCH_ENG__asyncInitFromURI() {
    return TaskUtils.spawn(function() {
      LOG("_asyncInitFromURI: Loading engine from: \"" + this._uri.spec + "\".");
      yield this._retrieveSearchXMLData(this._uri.spec);
      // Now that the data is loaded, initialize the engine object
      this._initFromData();
    }.bind(this));
  },

  /**
   * Retrieves the engine data for a given URI asynchronously.
   *
   * @returns {Promise} A promise, resolved successfully if retrieveing data
   * succeeds.
   */
  _retrieveSearchXMLData: function SRCH_ENG__retrieveSearchXMLData(aURL) {
    let deferred = Promise.defer();
    let request = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"].
                    createInstance(Ci.nsIXMLHttpRequest);
    request.overrideMimeType("text/xml");
    request.onload = (aEvent) => {
      let responseXML = aEvent.target.responseXML;
      this._data = responseXML.documentElement;
      deferred.resolve();
    };
    request.onerror = function(aEvent) {
      deferred.resolve();
    };
    request.open("GET", aURL, true);
    request.send();

    return deferred.promise;
  },

  _initFromURISync: function SRCH_ENG_initFromURISync() {
    ENSURE_WARN(this._uri instanceof Ci.nsIURI,
                "Must have URI when calling _initFromURISync!",
                Cr.NS_ERROR_UNEXPECTED);

    ENSURE_WARN(this._uri.schemeIs("chrome"), "_initFromURISync called for non-chrome URI",
                Cr.NS_ERROR_FAILURE);

    LOG("_initFromURISync: Loading engine from: \"" + this._uri.spec + "\".");

    var chan = NetUtil.ioService.newChannelFromURI(this._uri);

    var stream = chan.open();
    var parser = Cc["@mozilla.org/xmlextras/domparser;1"].
                 createInstance(Ci.nsIDOMParser);
    var doc = parser.parseFromStream(stream, "UTF-8", stream.available(), "text/xml");

    this._data = doc.documentElement;

    // Now that the data is loaded, initialize the engine object
    this._initFromData();
  },

  /**
   * Attempts to find an EngineURL object in the set of EngineURLs for
   * this Engine that has the given type string.  (This corresponds to the
   * "type" attribute in the "Url" node in the OpenSearch spec.)
   * This method will return the first matching URL object found, or null
   * if no matching URL is found.
   *
   * @param aType string to match the EngineURL's type attribute
   */
  _getURLOfType: function SRCH_ENG__getURLOfType(aType) {
    for (var i = 0; i < this._urls.length; ++i) {
      if (this._urls[i].type == aType)
        return this._urls[i];
    }

    return null;
  },

  _confirmAddEngine: function SRCH_SVC_confirmAddEngine() {
    var stringBundle = Services.strings.createBundle(SEARCH_BUNDLE);
    var titleMessage = stringBundle.GetStringFromName("addEngineConfirmTitle");

    // Display only the hostname portion of the URL.
    var dialogMessage =
        stringBundle.formatStringFromName("addEngineConfirmation",
                                          [this._name, this._uri.host], 2);
    var checkboxMessage = null;
    if (!getBoolPref(BROWSER_SEARCH_PREF + "noCurrentEngine", false))
      checkboxMessage = stringBundle.GetStringFromName("addEngineAsCurrentText");

    var addButtonLabel =
        stringBundle.GetStringFromName("addEngineAddButtonLabel");

    var ps = Services.prompt;
    var buttonFlags = (ps.BUTTON_TITLE_IS_STRING * ps.BUTTON_POS_0) +
                      (ps.BUTTON_TITLE_CANCEL    * ps.BUTTON_POS_1) +
                       ps.BUTTON_POS_0_DEFAULT;

    var checked = {value: false};
    // confirmEx returns the index of the button that was pressed.  Since "Add"
    // is button 0, we want to return the negation of that value.
    var confirm = !ps.confirmEx(null,
                                titleMessage,
                                dialogMessage,
                                buttonFlags,
                                addButtonLabel,
                                null, null, // button 1 & 2 names not used
                                checkboxMessage,
                                checked);

    return {confirmed: confirm, useNow: checked.value};
  },

  /**
   * Handle the successful download of an engine. Initializes the engine and
   * triggers parsing of the data. The engine is then flushed to disk. Notifies
   * the search service once initialization is complete.
   */
  _onLoad: function SRCH_ENG_onLoad(aBytes, aEngine) {
    /**
     * Handle an error during the load of an engine by notifying the engine's
     * error callback, if any.
     */
    function onError(errorCode = Ci.nsISearchInstallCallback.ERROR_UNKNOWN_FAILURE) {
      // Notify the callback of the failure
      if (aEngine._installCallback) {
        aEngine._installCallback(errorCode);
      }
    }

    function promptError(strings = {}, error = undefined) {
      onError(error);

      if (aEngine._engineToUpdate) {
        // We're in an update, so just fail quietly
        LOG("updating " + aEngine._engineToUpdate.name + " failed");
        return;
      }
      var brandBundle = Services.strings.createBundle(BRAND_BUNDLE);
      var brandName = brandBundle.GetStringFromName("brandShortName");

      var searchBundle = Services.strings.createBundle(SEARCH_BUNDLE);
      var msgStringName = strings.error || "error_loading_engine_msg2";
      var titleStringName = strings.title || "error_loading_engine_title";
      var title = searchBundle.GetStringFromName(titleStringName);
      var text = searchBundle.formatStringFromName(msgStringName,
                                                   [brandName, aEngine._location],
                                                   2);

      Services.ww.getNewPrompter(null).alert(title, text);
    }

    if (!aBytes) {
      promptError();
      return;
    }

    var engineToUpdate = null;
    if (aEngine._engineToUpdate) {
      engineToUpdate = aEngine._engineToUpdate.wrappedJSObject;

      // Make this new engine use the old engine's file.
      aEngine._file = engineToUpdate._file;
    }

    switch (aEngine._dataType) {
      case SEARCH_DATA_XML:
        var parser = Cc["@mozilla.org/xmlextras/domparser;1"].
                     createInstance(Ci.nsIDOMParser);
        var doc = parser.parseFromBuffer(aBytes, aBytes.length, "text/xml");
        aEngine._data = doc.documentElement;
        break;
      case SEARCH_DATA_TEXT:
        aEngine._data = aBytes;
        break;
      default:
        promptError();
        LOG("_onLoad: Bogus engine _dataType: \"" + this._dataType + "\"");
        return;
    }

    try {
      // Initialize the engine from the obtained data
      aEngine._initFromData();
    } catch (ex) {
      LOG("_onLoad: Failed to init engine!\n" + ex);
      // Report an error to the user
      promptError();
      return;
    }

    // Check that when adding a new engine (e.g., not updating an
    // existing one), a duplicate engine does not already exist.
    if (!engineToUpdate) {
      if (Services.search.getEngineByName(aEngine.name)) {
        // If we're confirming the engine load, then display a "this is a
        // duplicate engine" prompt; otherwise, fail silently.
        if (aEngine._confirm) {
          promptError({ error: "error_duplicate_engine_msg",
                        title: "error_invalid_engine_title"
                      }, Ci.nsISearchInstallCallback.ERROR_DUPLICATE_ENGINE);
        } else {
          onError(Ci.nsISearchInstallCallback.ERROR_DUPLICATE_ENGINE);
        }
        LOG("_onLoad: duplicate engine found, bailing");
        return;
      }
    }

    // If requested, confirm the addition now that we have the title.
    // This property is only ever true for engines added via
    // nsIBrowserSearchService::addEngine.
    if (aEngine._confirm) {
      var confirmation = aEngine._confirmAddEngine();
      LOG("_onLoad: confirm is " + confirmation.confirmed +
          "; useNow is " + confirmation.useNow);
      if (!confirmation.confirmed) {
        onError();
        return;
      }
      aEngine._useNow = confirmation.useNow;
    }

    // If we don't yet have a file, get one now. The only case where we would
    // already have a file is if this is an update and _file was set above.
    if (!aEngine._file)
      aEngine._file = getSanitizedFile(aEngine.name);

    if (engineToUpdate) {
      // Keep track of the last modified date, so that we can make conditional
      // requests for future updates.
      engineMetadataService.setAttr(aEngine, "updatelastmodified",
                                    (new Date()).toUTCString());

      // If we're updating an app-shipped engine, ensure that the updateURLs
      // are the same.
      if (engineToUpdate._isInAppDir) {
        let oldUpdateURL = engineToUpdate._updateURL;
        let newUpdateURL = aEngine._updateURL;
        let oldSelfURL = engineToUpdate._getURLOfType(URLTYPE_OPENSEARCH);
        if (oldSelfURL && oldSelfURL._hasRelation("self")) {
          oldUpdateURL = oldSelfURL.template;
          let newSelfURL = aEngine._getURLOfType(URLTYPE_OPENSEARCH);
          if (!newSelfURL || !newSelfURL._hasRelation("self")) {
            LOG("_onLoad: updateURL missing in updated engine for " +
                aEngine.name + " aborted");
            onError();
            return;
          }
          newUpdateURL = newSelfURL.template;
        }

        if (oldUpdateURL != newUpdateURL) {
          LOG("_onLoad: updateURLs do not match! Update of " + aEngine.name + " aborted");
          onError();
          return;
        }
      }

      // Set the new engine's icon, if it doesn't yet have one.
      if (!aEngine._iconURI && engineToUpdate._iconURI)
        aEngine._iconURI = engineToUpdate._iconURI;
    }

    // Write the engine to file. For readOnly engines, they'll be stored in the
    // cache following the notification below.
    if (!aEngine._readOnly)
      aEngine._serializeToFile();

    // Notify the search service of the successful load. It will deal with
    // updates by checking aEngine._engineToUpdate.
    notifyAction(aEngine, SEARCH_ENGINE_LOADED);

    // Notify the callback if needed
    if (aEngine._installCallback) {
      aEngine._installCallback();
    }
  },

  /**
   * Creates a key by serializing an object that contains the icon's width
   * and height.
   *
   * @param aWidth
   *        Width of the icon.
   * @param aHeight
   *        Height of the icon.
   * @returns key string
   */
  _getIconKey: function SRCH_ENG_getIconKey(aWidth, aHeight) {
    let keyObj = {
     width: aWidth,
     height: aHeight
    };

    return JSON.stringify(keyObj);
  },

  /**
   * Add an icon to the icon map used by getIconURIBySize() and getIcons().
   *
   * @param aWidth
   *        Width of the icon.
   * @param aHeight
   *        Height of the icon.
   * @param aURISpec
   *        String with the icon's URI.
   */
  _addIconToMap: function SRCH_ENG_addIconToMap(aWidth, aHeight, aURISpec) {
    // Use an object instead of a Map() because it needs to be serializable.
    this._iconMapObj = this._iconMapObj || {};
    let key = this._getIconKey(aWidth, aHeight);
    this._iconMapObj[key] = aURISpec;
  },

  /**
   * Sets the .iconURI property of the engine. If both aWidth and aHeight are
   * provided an entry will be added to _iconMapObj that will enable accessing
   * icon's data through getIcons() and getIconURIBySize() APIs.
   *
   *  @param aIconURL
   *         A URI string pointing to the engine's icon. Must have a http[s],
   *         ftp, or data scheme. Icons with HTTP[S] or FTP schemes will be
   *         downloaded and converted to data URIs for storage in the engine
   *         XML files, if the engine is not readonly.
   *  @param aIsPreferred
   *         Whether or not this icon is to be preferred. Preferred icons can
   *         override non-preferred icons.
   *  @param aWidth (optional)
   *         Width of the icon.
   *  @param aHeight (optional)
   *         Height of the icon.
   */
  _setIcon: function SRCH_ENG_setIcon(aIconURL, aIsPreferred, aWidth, aHeight) {
    var uri = makeURI(aIconURL);

    // Ignore bad URIs
    if (!uri)
      return;

    LOG("_setIcon: Setting icon url \"" + limitURILength(uri.spec) + "\" for engine \""
        + this.name + "\".");
    // Only accept remote icons from http[s] or ftp
    switch (uri.scheme) {
      case "data":
        if (!this._hasPreferredIcon || aIsPreferred) {
          this._iconURI = uri;
          notifyAction(this, SEARCH_ENGINE_CHANGED);
          this._hasPreferredIcon = aIsPreferred;
        }

        if (aWidth && aHeight) {
          this._addIconToMap(aWidth, aHeight, aIconURL)
        }
        break;
      case "http":
      case "https":
      case "ftp":
        // No use downloading the icon if the engine file is read-only
        if (!this._readOnly ||
            getBoolPref(BROWSER_SEARCH_PREF + "cache.enabled", true)) {
          LOG("_setIcon: Downloading icon: \"" + uri.spec +
              "\" for engine: \"" + this.name + "\"");
          var chan = NetUtil.ioService.newChannelFromURI(uri);

          function iconLoadCallback(aByteArray, aEngine) {
            // This callback may run after we've already set a preferred icon,
            // so check again.
            if (aEngine._hasPreferredIcon && !aIsPreferred)
              return;

            if (!aByteArray || aByteArray.length > MAX_ICON_SIZE) {
              LOG("iconLoadCallback: load failed, or the icon was too large!");
              return;
            }

            var str = btoa(String.fromCharCode.apply(null, aByteArray));
            let dataURL = ICON_DATAURL_PREFIX + str;
            aEngine._iconURI = makeURI(dataURL);

            if (aWidth && aHeight) {
              aEngine._addIconToMap(aWidth, aHeight, dataURL)
            }

            // The engine might not have a file yet, if it's being downloaded,
            // because the request for the engine file itself (_onLoad) may not
            // yet be complete. In that case, this change will be written to
            // file when _onLoad is called. For readonly engines, we'll store
            // the changes in the cache once notified below.
            if (aEngine._file && !aEngine._readOnly)
              aEngine._serializeToFile();

            notifyAction(aEngine, SEARCH_ENGINE_CHANGED);
            aEngine._hasPreferredIcon = aIsPreferred;
          }

          // If we're currently acting as an "update engine", then the callback
          // should set the icon on the engine we're updating and not us, since
          // |this| might be gone by the time the callback runs.
          var engineToSet = this._engineToUpdate || this;

          var listener = new loadListener(chan, engineToSet, iconLoadCallback);
          chan.notificationCallbacks = listener;
          chan.asyncOpen(listener, null);
        }
        break;
    }
  },

  /**
   * Initialize this Engine object from the collected data.
   */
  _initFromData: function SRCH_ENG_initFromData() {
    ENSURE_WARN(this._data, "Can't init an engine with no data!",
                Cr.NS_ERROR_UNEXPECTED);

    // Find out what type of engine we are
    switch (this._dataType) {
      case SEARCH_DATA_XML:
        if (checkNameSpace(this._data, [MOZSEARCH_LOCALNAME],
            [MOZSEARCH_NS_10])) {

          LOG("_init: Initing MozSearch plugin from " + this._location);

          this._type = SEARCH_TYPE_MOZSEARCH;
          this._parseAsMozSearch();

        } else if (checkNameSpace(this._data, [OPENSEARCH_LOCALNAME],
                                  OPENSEARCH_NAMESPACES)) {

          LOG("_init: Initing OpenSearch plugin from " + this._location);

          this._type = SEARCH_TYPE_OPENSEARCH;
          this._parseAsOpenSearch();

        } else
          FAIL(this._location + " is not a valid search plugin.", Cr.NS_ERROR_FAILURE);

        break;
      case SEARCH_DATA_TEXT:
        LOG("_init: Initing Sherlock plugin from " + this._location);

        // the only text-based format we support is Sherlock
        this._type = SEARCH_TYPE_SHERLOCK;
        this._parseAsSherlock();
    }

    // No need to keep a ref to our data (which in some cases can be a document
    // element) past this point
    this._data = null;
  },

  /**
   * Initialize this Engine object from a collection of metadata.
   */
  _initFromMetadata: function SRCH_ENG_initMetaData(aName, aIconURL, aAlias,
                                                    aDescription, aMethod,
                                                    aTemplate) {
    ENSURE_WARN(!this._readOnly,
                "Can't call _initFromMetaData on a readonly engine!",
                Cr.NS_ERROR_FAILURE);

    this._urls.push(new EngineURL("text/html", aMethod, aTemplate));

    this._name = aName;
    this.alias = aAlias;
    this._description = aDescription;
    this._setIcon(aIconURL, true);

    this._serializeToFile();
  },

  /**
   * Extracts data from an OpenSearch URL element and creates an EngineURL
   * object which is then added to the engine's list of URLs.
   *
   * @throws NS_ERROR_FAILURE if a URL object could not be created.
   *
   * @see http://opensearch.a9.com/spec/1.1/querysyntax/#urltag.
   * @see EngineURL()
   */
  _parseURL: function SRCH_ENG_parseURL(aElement) {
    var type     = aElement.getAttribute("type");
    // According to the spec, method is optional, defaulting to "GET" if not
    // specified
    var method   = aElement.getAttribute("method") || "GET";
    var template = aElement.getAttribute("template");

    try {
      var url = new EngineURL(type, method, template);
    } catch (ex) {
      FAIL("_parseURL: failed to add " + template + " as a URL",
           Cr.NS_ERROR_FAILURE);
    }

    if (aElement.hasAttribute("rel"))
      url.rels = aElement.getAttribute("rel").toLowerCase().split(/\s+/);

    for (var i = 0; i < aElement.childNodes.length; ++i) {
      var param = aElement.childNodes[i];
      if (param.localName == "Param") {
        try {
          url.addParam(param.getAttribute("name"), param.getAttribute("value"));
        } catch (ex) {
          // Ignore failure
          LOG("_parseURL: Url element has an invalid param");
        }
      } else if (param.localName == "MozParam" &&
                 // We only support MozParams for default search engines
                 this._isDefault) {
        var value;
        let condition = param.getAttribute("condition");
        switch (condition) {
          case "purpose":
            url.addParam(param.getAttribute("name"),
                         param.getAttribute("value"),
                         param.getAttribute("purpose"));
            // _addMozParam is not needed here since it can be serialized fine without. _addMozParam
            // also requires a unique "name" which is not normally the case when @purpose is used.
            break;
          case "defaultEngine":
            // If this engine was the default search engine, use the true value
            if (this._isDefaultEngine())
              value = param.getAttribute("trueValue");
            else
              value = param.getAttribute("falseValue");
            url.addParam(param.getAttribute("name"), value);
            url._addMozParam({"name": param.getAttribute("name"),
                              "falseValue": param.getAttribute("falseValue"),
                              "trueValue": param.getAttribute("trueValue"),
                              "condition": "defaultEngine"});
            break;

          case "pref":
            try {
              value = getMozParamPref(param.getAttribute("pref"), value);
              url.addParam(param.getAttribute("name"), value);
              url._addMozParam({"pref": param.getAttribute("pref"),
                                "name": param.getAttribute("name"),
                                "condition": "pref"});
            } catch (e) { }
            break;
          default:
            if (condition && condition.startsWith("top")) {
              url.addParam(param.getAttribute("name"), param.getAttribute("falseValue"));
              let mozparam = {"name": param.getAttribute("name"),
                              "falseValue": param.getAttribute("falseValue"),
                              "trueValue": param.getAttribute("trueValue"),
                              "condition": condition,
                              "positionDependent": true};
              url._addMozParam(mozparam);
            }
          break;
        }
      }
    }

    this._urls.push(url);
  },

  _isDefaultEngine: function SRCH_ENG__isDefaultEngine() {
    let defaultPrefB = Services.prefs.getDefaultBranch(BROWSER_SEARCH_PREF);
    let nsIPLS = Ci.nsIPrefLocalizedString;
    let defaultEngine;
    try {
      defaultEngine = defaultPrefB.getComplexValue("defaultenginename", nsIPLS).data;
    } catch (ex) {}
    return this.name == defaultEngine;
  },

  /**
   * Get the icon from an OpenSearch Image element.
   * @see http://opensearch.a9.com/spec/1.1/description/#image
   */
  _parseImage: function SRCH_ENG_parseImage(aElement) {
    LOG("_parseImage: Image textContent: \"" + limitURILength(aElement.textContent) + "\"");

    let width = parseInt(aElement.getAttribute("width"), 10);
    let height = parseInt(aElement.getAttribute("height"), 10);
    let isPrefered = width == 16 && height == 16;

    if (isNaN(width) || isNaN(height) || width <= 0 || height <=0) {
      LOG("OpenSearch image element must have positive width and height.");
      return;
    }

    this._setIcon(aElement.textContent, isPrefered, width, height);
  },

  _parseAsMozSearch: function SRCH_ENG_parseAsMoz() {
    //forward to the OpenSearch parser
    this._parseAsOpenSearch();
  },

  /**
   * Extract search engine information from the collected data to initialize
   * the engine object.
   */
  _parseAsOpenSearch: function SRCH_ENG_parseAsOS() {
    var doc = this._data;

    // The OpenSearch spec sets a default value for the input encoding.
    this._queryCharset = OS_PARAM_INPUT_ENCODING_DEF;

    for (var i = 0; i < doc.childNodes.length; ++i) {
      var child = doc.childNodes[i];
      switch (child.localName) {
        case "ShortName":
          this._name = child.textContent;
          break;
        case "Description":
          this._description = child.textContent;
          break;
        case "Url":
          try {
            this._parseURL(child);
          } catch (ex) {
            // Parsing of the element failed, just skip it.
            LOG("_parseAsOpenSearch: failed to parse URL child: " + ex);
          }
          break;
        case "Image":
          this._parseImage(child);
          break;
        case "InputEncoding":
          this._queryCharset = child.textContent.toUpperCase();
          break;

        // Non-OpenSearch elements
        case "SearchForm":
          this._searchForm = child.textContent;
          break;
        case "UpdateUrl":
          this._updateURL = child.textContent;
          break;
        case "UpdateInterval":
          this._updateInterval = parseInt(child.textContent);
          break;
        case "IconUpdateUrl":
          this._iconUpdateURL = child.textContent;
          break;
      }
    }
    if (!this.name || (this._urls.length == 0))
      FAIL("_parseAsOpenSearch: No name, or missing URL!", Cr.NS_ERROR_FAILURE);
    if (!this.supportsResponseType(URLTYPE_SEARCH_HTML))
      FAIL("_parseAsOpenSearch: No text/html result type!", Cr.NS_ERROR_FAILURE);
  },

  /**
   * Extract search engine information from the collected data to initialize
   * the engine object.
   */
  _parseAsSherlock: function SRCH_ENG_parseAsSherlock() {
    /**
     * Extracts one Sherlock "section" from aSource. A section is essentially
     * an HTML element with attributes, but each attribute must be on a new
     * line, by definition.
     *
     * @param aLines
     *        An array of lines from the sherlock file.
     * @param aSection
     *        The name of the section (e.g. "search" or "browser"). This value
     *        is not case sensitive.
     * @returns an object whose properties correspond to the section's
     *          attributes.
     */
    function getSection(aLines, aSection) {
      LOG("_parseAsSherlock::getSection: Sherlock lines:\n" +
          aLines.join("\n"));
      var lines = aLines;
      var startMark = new RegExp("^\\s*<" + aSection.toLowerCase() + "\\s*",
                                 "gi");
      var endMark   = /\s*>\s*$/gi;

      var foundStart = false;
      var startLine, numberOfLines;
      // Find the beginning and end of the section
      for (var i = 0; i < lines.length; i++) {
        if (foundStart) {
          if (endMark.test(lines[i])) {
            numberOfLines = i - startLine;
            // Remove the end marker
            lines[i] = lines[i].replace(endMark, "");
            // If the endmarker was not the only thing on the line, include
            // this line in the results
            if (lines[i])
              numberOfLines++;
            break;
          }
        } else {
          if (startMark.test(lines[i])) {
            foundStart = true;
            // Remove the start marker
            lines[i] = lines[i].replace(startMark, "");
            startLine = i;
            // If the line is empty, don't include it in the result
            if (!lines[i])
              startLine++;
          }
        }
      }
      LOG("_parseAsSherlock::getSection: Start index: " + startLine +
          "\nNumber of lines: " + numberOfLines);
      lines = lines.splice(startLine, numberOfLines);
      LOG("_parseAsSherlock::getSection: Section lines:\n" +
          lines.join("\n"));

      var section = {};
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();

        var els = line.split("=");
        var name = els.shift().trim().toLowerCase();
        var value = els.join("=").trim();

        if (!name || !value)
          continue;

        // Strip leading and trailing whitespace, remove quotes from the
        // value, and remove any trailing slashes or ">" characters
        value = value.replace(/^["']/, "")
                     .replace(/["']\s*[\\\/]?>?\s*$/, "") || "";
        value = value.trim();

        // Don't clobber existing attributes
        if (!(name in section))
          section[name] = value;
      }
      return section;
    }

    /**
     * Returns an array of name-value pair arrays representing the Sherlock
     * file's input elements. User defined inputs return USER_DEFINED
     * as the value. Elements are returned in the order they appear in the
     * source file.
     *
     *   Example:
     *      <input name="foo" value="bar">
     *      <input name="foopy" user>
     *   Returns:
     *      [["foo", "bar"], ["foopy", "{searchTerms}"]]
     *
     * @param aLines
     *        An array of lines from the source file.
     */
    function getInputs(aLines) {

      /**
       * Extracts an attribute value from a given a line of text.
       *    Example: <input value="foo" name="bar">
       *      Extracts the string |foo| or |bar| given an input aAttr of
       *      |value| or |name|.
       * Attributes may be quoted or unquoted. If unquoted, any whitespace
       * indicates the end of the attribute value.
       *    Example: < value=22 33 name=44\334 >
       *      Returns |22| for "value" and |44\334| for "name".
       *
       * @param aAttr
       *        The name of the attribute for which to obtain the value. This
       *        value is not case sensitive.
       * @param aLine
       *        The line containing the attribute.
       *
       * @returns the attribute value, or an empty string if the attribute
       *          doesn't exist.
       */
      function getAttr(aAttr, aLine) {
        // Used to determine whether an "input" line from a Sherlock file is a
        // "user defined" input.
        const userInput = /(\s|["'=])user(\s|[>="'\/\\+]|$)/i;

        LOG("_parseAsSherlock::getAttr: Getting attr: \"" +
            aAttr + "\" for line: \"" + aLine + "\"");
        // We're not case sensitive, but we want to return the attribute value
        // in its original case, so create a copy of the source
        var lLine = aLine.toLowerCase();
        var attr = aAttr.toLowerCase();

        var attrStart = lLine.search(new RegExp("\\s" + attr, "i"));
        if (attrStart == -1) {

          // If this is the "user defined input" (i.e. contains the empty
          // "user" attribute), return our special keyword
          if (userInput.test(lLine) && attr == "value") {
            LOG("_parseAsSherlock::getAttr: Found user input!\nLine:\"" + lLine
                + "\"");
            return USER_DEFINED;
          }
          // The attribute doesn't exist - ignore
          LOG("_parseAsSherlock::getAttr: Failed to find attribute:\nLine:\""
              + lLine + "\"\nAttr:\"" + attr + "\"");
          return "";
        }

        var valueStart = lLine.indexOf("=", attrStart) + "=".length;
        if (valueStart == -1)
          return "";

        var quoteStart = lLine.indexOf("\"", valueStart);
        if (quoteStart == -1) {

          // Unquoted attribute, get the rest of the line, trimmed at the first
          // sign of whitespace. If the rest of the line is only whitespace,
          // returns a blank string.
          return lLine.substr(valueStart).replace(/\s.*$/, "");

        } else {
          // Make sure that there's only whitespace between the start of the
          // value and the first quote. If there is, end the attribute value at
          // the first sign of whitespace. This prevents us from falling into
          // the next attribute if this is an unquoted attribute followed by a
          // quoted attribute.
          var betweenEqualAndQuote = lLine.substring(valueStart, quoteStart);
          if (/\S/.test(betweenEqualAndQuote))
            return lLine.substr(valueStart).replace(/\s.*$/, "");

          // Adjust the start index to account for the opening quote
          valueStart = quoteStart + "\"".length;
          // Find the closing quote
          var valueEnd = lLine.indexOf("\"", valueStart);
          // If there is no closing quote, just go to the end of the line
          if (valueEnd == -1)
            valueEnd = aLine.length;
        }
        return aLine.substring(valueStart, valueEnd);
      }

      var inputs = [];

      LOG("_parseAsSherlock::getInputs: Lines:\n" + aLines);
      // Filter out everything but non-inputs
      let lines = aLines.filter(function (line) {
        return /^\s*<input/i.test(line);
      });
      LOG("_parseAsSherlock::getInputs: Filtered lines:\n" + lines);

      lines.forEach(function (line) {
        // Strip leading/trailing whitespace and remove the surrounding markup
        // ("<input" and ">")
        line = line.trim().replace(/^<input/i, "").replace(/>$/, "");

        // If this is one of the "directional" inputs (<inputnext>/<inputprev>)
        const directionalInput = /^(prev|next)/i;
        if (directionalInput.test(line)) {

          // Make it look like a normal input by removing "prev" or "next"
          line = line.replace(directionalInput, "");

          // If it has a name, give it a dummy value to match previous
          // nsInternetSearchService behavior
          if (/name\s*=/i.test(line)) {
            line += " value=\"0\"";
          } else
            return; // Line has no name, skip it
        }

        var attrName = getAttr("name", line);
        var attrValue = getAttr("value", line);
        LOG("_parseAsSherlock::getInputs: Got input:\nName:\"" + attrName +
            "\"\nValue:\"" + attrValue + "\"");
        if (attrValue)
          inputs.push([attrName, attrValue]);
      });
      return inputs;
    }

    function err(aErr) {
      FAIL("_parseAsSherlock::err: Sherlock param error:\n" + aErr,
           Cr.NS_ERROR_FAILURE);
    }

    // First try converting our byte array using the default Sherlock encoding.
    // If this fails, or if we find a sourceTextEncoding attribute, we need to
    // reconvert the byte array using the specified encoding.
    var sherlockLines, searchSection, sourceTextEncoding, browserSection;
    try {
      sherlockLines = sherlockBytesToLines(this._data);
      searchSection = getSection(sherlockLines, "search");
      browserSection = getSection(sherlockLines, "browser");
      sourceTextEncoding = parseInt(searchSection["sourcetextencoding"]);
      if (sourceTextEncoding) {
        // Re-convert the bytes using the found sourceTextEncoding
        sherlockLines = sherlockBytesToLines(this._data, sourceTextEncoding);
        searchSection = getSection(sherlockLines, "search");
        browserSection = getSection(sherlockLines, "browser");
      }
    } catch (ex) {
      // The conversion using the default charset failed. Remove any non-ascii
      // bytes and try to find a sourceTextEncoding.
      var asciiBytes = this._data.filter(function (n) {return !(0x80 & n);});
      var asciiString = String.fromCharCode.apply(null, asciiBytes);
      sherlockLines = asciiString.split(NEW_LINES).filter(isUsefulLine);
      searchSection = getSection(sherlockLines, "search");
      sourceTextEncoding = parseInt(searchSection["sourcetextencoding"]);
      if (sourceTextEncoding) {
        sherlockLines = sherlockBytesToLines(this._data, sourceTextEncoding);
        searchSection = getSection(sherlockLines, "search");
        browserSection = getSection(sherlockLines, "browser");
      } else
        ERROR("Couldn't find a working charset", Cr.NS_ERROR_FAILURE);
    }

    LOG("_parseAsSherlock: Search section:\n" + searchSection.toSource());

    this._name = searchSection["name"] || err("Missing name!");
    this._description = searchSection["description"] || "";
    this._queryCharset = searchSection["querycharset"] ||
                         queryCharsetFromCode(searchSection["queryencoding"]);
    this._searchForm = searchSection["searchform"];

    this._updateInterval = parseInt(browserSection["updatecheckdays"]);

    this._updateURL = browserSection["update"];
    this._iconUpdateURL = browserSection["updateicon"];

    var method = (searchSection["method"] || "GET").toUpperCase();
    var template = searchSection["action"] || err("Missing action!");

    var inputs = getInputs(sherlockLines);
    LOG("_parseAsSherlock: Inputs:\n" + inputs.toSource());

    var url = null;

    if (method == "GET") {
      // Here's how we construct the input string:
      // <input> is first:  Name Attr:  Prefix      Data           Example:
      // YES                EMPTY       None        <value>        TEMPLATE<value>
      // YES                NON-EMPTY   ?           <name>=<value> TEMPLATE?<name>=<value>
      // NO                 EMPTY       ------------- <ignored> --------------
      // NO                 NON-EMPTY   &           <name>=<value> TEMPLATE?<n1>=<v1>&<n2>=<v2>
      for (var i = 0; i < inputs.length; i++) {
        var name  = inputs[i][0];
        var value = inputs[i][1];
        if (i==0) {
          if (name == "")
            template += USER_DEFINED;
          else
            template += "?" + name + "=" + value;
        } else if (name != "")
          template += "&" + name + "=" + value;
      }
      url = new EngineURL("text/html", method, template);

    } else if (method == "POST") {
      // Create the URL object and just add the parameters directly
      url = new EngineURL("text/html", method, template);
      for (var i = 0; i < inputs.length; i++) {
        var name  = inputs[i][0];
        var value = inputs[i][1];
        if (name)
          url.addParam(name, value);
      }
    } else
      err("Invalid method!");

    this._urls.push(url);
  },

  /**
   * Init from a JSON record.
   **/
  _initWithJSON: function SRCH_ENG__initWithJSON(aJson) {
    this.__id = aJson._id;
    this._name = aJson._name;
    this._description = aJson.description;
    if (aJson._hasPreferredIcon == undefined)
      this._hasPreferredIcon = true;
    else
      this._hasPreferredIcon = false;
    this._hidden = aJson._hidden;
    this._type = aJson.type || SEARCH_TYPE_MOZSEARCH;
    this._queryCharset = aJson.queryCharset || DEFAULT_QUERY_CHARSET;
    this.__searchForm = aJson.__searchForm;
    this.__installLocation = aJson._installLocation || SEARCH_APP_DIR;
    this._updateInterval = aJson._updateInterval || null;
    this._updateURL = aJson._updateURL || null;
    this._iconUpdateURL = aJson._iconUpdateURL || null;
    if (aJson._readOnly == undefined)
      this._readOnly = true;
    else
      this._readOnly = false;
    this._iconURI = makeURI(aJson._iconURL);
    this._iconMapObj = aJson._iconMapObj;
    for (let i = 0; i < aJson._urls.length; ++i) {
      let url = aJson._urls[i];
      let engineURL = new EngineURL(url.type || URLTYPE_SEARCH_HTML,
                                    url.method || "GET", url.template);
      engineURL._initWithJSON(url, this);
      this._urls.push(engineURL);
    }
  },

  /**
   * Creates a JavaScript object that represents this engine.
   * @param aFilter
   *        Whether or not to filter out common default values. Recommended for
   *        use with _initWithJSON().
   * @returns An object suitable for serialization as JSON.
   **/
  _serializeToJSON: function SRCH_ENG__serializeToJSON(aFilter) {
    var json = {
      _id: this._id,
      _name: this._name,
      _hidden: this.hidden,
      description: this.description,
      __searchForm: this.__searchForm,
      _iconURL: this._iconURL,
      _iconMapObj: this._iconMapObj,
      _urls: [url._serializeToJSON() for each(url in this._urls)]
    };

    if (this._file instanceof Ci.nsILocalFile)
      json.filePath = this._file.persistentDescriptor;
    if (this._uri)
      json._url = this._uri.spec;
    if (this._installLocation != SEARCH_APP_DIR || !aFilter)
      json._installLocation = this._installLocation;
    if (this._updateInterval || !aFilter)
      json._updateInterval = this._updateInterval;
    if (this._updateURL || !aFilter)
      json._updateURL = this._updateURL;
    if (this._iconUpdateURL || !aFilter)
      json._iconUpdateURL = this._iconUpdateURL;
    if (!this._hasPreferredIcon || !aFilter)
      json._hasPreferredIcon = this._hasPreferredIcon;
    if (this.type != SEARCH_TYPE_MOZSEARCH || !aFilter)
      json.type = this.type;
    if (this.queryCharset != DEFAULT_QUERY_CHARSET || !aFilter)
      json.queryCharset = this.queryCharset;
    if (this._dataType != SEARCH_DATA_XML || !aFilter)
      json._dataType = this._dataType;
    if (!this._readOnly || !aFilter)
      json._readOnly = this._readOnly;

    return json;
  },

  /**
   * Returns an XML document object containing the search plugin information,
   * which can later be used to reload the engine.
   */
  _serializeToElement: function SRCH_ENG_serializeToEl() {
    function appendTextNode(aNameSpace, aLocalName, aValue) {
      if (!aValue)
        return null;
      var node = doc.createElementNS(aNameSpace, aLocalName);
      node.appendChild(doc.createTextNode(aValue));
      docElem.appendChild(node);
      docElem.appendChild(doc.createTextNode("\n"));
      return node;
    }

    var parser = Cc["@mozilla.org/xmlextras/domparser;1"].
                 createInstance(Ci.nsIDOMParser);

    var doc = parser.parseFromString(EMPTY_DOC, "text/xml");
    var docElem = doc.documentElement;

    docElem.appendChild(doc.createTextNode("\n"));

    appendTextNode(OPENSEARCH_NS_11, "ShortName", this.name);
    appendTextNode(OPENSEARCH_NS_11, "Description", this._description);
    appendTextNode(OPENSEARCH_NS_11, "InputEncoding", this._queryCharset);

    if (this._iconURI) {
      var imageNode = appendTextNode(OPENSEARCH_NS_11, "Image",
                                     this._iconURI.spec);
      if (imageNode) {
        imageNode.setAttribute("width", "16");
        imageNode.setAttribute("height", "16");
      }
    }

    appendTextNode(MOZSEARCH_NS_10, "UpdateInterval", this._updateInterval);
    appendTextNode(MOZSEARCH_NS_10, "UpdateUrl", this._updateURL);
    appendTextNode(MOZSEARCH_NS_10, "IconUpdateUrl", this._iconUpdateURL);
    appendTextNode(MOZSEARCH_NS_10, "SearchForm", this._searchForm);

    for (var i = 0; i < this._urls.length; ++i)
      this._urls[i]._serializeToElement(doc, docElem);
    docElem.appendChild(doc.createTextNode("\n"));

    return doc;
  },

  get lazySerializeTask() {
    if (!this._lazySerializeTask) {
      let task = function taskCallback() {
        this._serializeToFile();
      }.bind(this);
      this._lazySerializeTask = new DeferredTask(task, LAZY_SERIALIZE_DELAY);
    }

    return this._lazySerializeTask;
  },

  /**
   * Serializes the engine object to file.
   */
  _serializeToFile: function SRCH_ENG_serializeToFile() {
    var file = this._file;
    ENSURE_WARN(!this._readOnly, "Can't serialize a read only engine!",
                Cr.NS_ERROR_FAILURE);
    ENSURE_WARN(file && file.exists(), "Can't serialize: file doesn't exist!",
                Cr.NS_ERROR_UNEXPECTED);

    var fos = Cc["@mozilla.org/network/safe-file-output-stream;1"].
              createInstance(Ci.nsIFileOutputStream);

    // Serialize the engine first - we don't want to overwrite a good file
    // if this somehow fails.
    var doc = this._serializeToElement();

    fos.init(file, (MODE_WRONLY | MODE_TRUNCATE), PERMS_FILE, 0);

    try {
      var serializer = Cc["@mozilla.org/xmlextras/xmlserializer;1"].
                       createInstance(Ci.nsIDOMSerializer);
      serializer.serializeToStream(doc.documentElement, fos, null);
    } catch (e) {
      LOG("_serializeToFile: Error serializing engine:\n" + e);
    }

    closeSafeOutputStream(fos);

    Services.obs.notifyObservers(file.clone(), SEARCH_SERVICE_TOPIC,
                                 "write-engine-to-disk-complete");
  },

  /**
   * Remove the engine's file from disk. The search service calls this once it
   * removes the engine from its internal store. This function will throw if
   * the file cannot be removed.
   */
  _remove: function SRCH_ENG_remove() {
    if (this._readOnly)
      FAIL("Can't remove read only engine!", Cr.NS_ERROR_FAILURE);
    if (!this._file || !this._file.exists())
      FAIL("Can't remove engine: file doesn't exist!", Cr.NS_ERROR_FILE_NOT_FOUND);

    this._file.remove(false);
  },

  // nsISearchEngine
  get alias() {
    if (this._alias === undefined)
      this._alias = engineMetadataService.getAttr(this, "alias");

    return this._alias;
  },
  set alias(val) {
    this._alias = val;
    engineMetadataService.setAttr(this, "alias", val);
    notifyAction(this, SEARCH_ENGINE_CHANGED);
  },

  /**
   * Return the built-in identifier of app-provided engines.
   *
   * Note that this identifier is substantially similar to _id, with the
   * following exceptions:
   *
   * * There is no trailing file extension.
   * * There is no [app] prefix.
   *
   * @return a string identifier, or null.
   */
  get identifier() {
    if (this._identifier !== undefined) {
      return this._identifier;
    }

    // No identifier if If the engine isn't app-provided
    if (!this._isInAppDir && !this._isInJAR) {
      return this._identifier = null;
    }

    let leaf = this._getLeafName();
    ENSURE_WARN(leaf, "identifier: app-provided engine has no leafName");

    // Strip file extension.
    let ext = leaf.lastIndexOf(".");
    if (ext == -1) {
      return this._identifier = leaf;
    }
    return this._identifier = leaf.substring(0, ext);
  },

  get description() {
    return this._description;
  },

  get hidden() {
    if (this._hidden === null)
      this._hidden = engineMetadataService.getAttr(this, "hidden") || false;
    return this._hidden;
  },
  set hidden(val) {
    var value = !!val;
    if (value != this._hidden) {
      this._hidden = value;
      engineMetadataService.setAttr(this, "hidden", value);
      notifyAction(this, SEARCH_ENGINE_CHANGED);
    }
  },

  get iconURI() {
    if (this._iconURI)
      return this._iconURI;
    return null;
  },

  get _iconURL() {
    if (!this._iconURI)
      return "";
    return this._iconURI.spec;
  },

  // Where the engine is being loaded from: will return the URI's spec if the
  // engine is being downloaded and does not yet have a file. This is only used
  // for logging and error messages.
  get _location() {
    if (this._file)
      return this._file.path;

    if (this._uri)
      return this._uri.spec;

    return "";
  },

  /**
   * @return the leaf name of the filename or URI of this plugin,
   *         or null if no file or URI is known.
   */
  _getLeafName: function () {
    if (this._file) {
      return this._file.leafName;
    }
    if (this._uri && this._uri instanceof Ci.nsIURL) {
      return this._uri.fileName;
    }
    return null;
  },
    
  // The file that the plugin is loaded from is a unique identifier for it.  We
  // use this as the identifier to store data in the sqlite database
  __id: null,
  get _id() {
    if (this.__id) {
      return this.__id;
    }

    let leafName = this._getLeafName();

    // Treat engines loaded from JARs the same way we treat app shipped
    // engines.
    // Theoretically, these could also come from extensions, but there's no
    // real way for extensions to register their chrome locations at the
    // moment, so let's not deal with that case.
    // This means we're vulnerable to conflicts if a file loaded from a JAR
    // has the same filename as a file loaded from the app dir, but with a
    // different engine name. People using the JAR functionality should be
    // careful not to do that!
    if (this._isInAppDir || this._isInJAR) {
      // App dir and JAR engines should always have leafNames
      ENSURE_WARN(leafName, "_id: no leafName for appDir or JAR engine",
                  Cr.NS_ERROR_UNEXPECTED);
      return this.__id = "[app]/" + leafName;
    }

    if (this._isInProfile) {
      ENSURE_WARN(leafName, "_id: no leafName for profile engine",
                  Cr.NS_ERROR_UNEXPECTED);
      return this.__id = "[profile]/" + leafName;
    }

    // If the engine isn't a JAR engine, it should have a file.
    ENSURE_WARN(this._file, "_id: no _file for non-JAR engine",
                Cr.NS_ERROR_UNEXPECTED);

    // We're not in the profile or appdir, so this must be an extension-shipped
    // plugin. Use the full filename.
    return this.__id = this._file.path;
  },

  get _installLocation() {
    if (this.__installLocation === null) {
      if (!this._file) {
        ENSURE_WARN(this._uri, "Engines without files must have URIs",
                    Cr.NS_ERROR_UNEXPECTED);
        this.__installLocation = SEARCH_JAR;
      }
      else if (this._file.parent.equals(getDir(NS_APP_SEARCH_DIR)))
        this.__installLocation = SEARCH_APP_DIR;
      else if (this._file.parent.equals(getDir(NS_APP_USER_SEARCH_DIR)))
        this.__installLocation = SEARCH_PROFILE_DIR;
      else
        this.__installLocation = SEARCH_IN_EXTENSION;
    }

    return this.__installLocation;
  },

  get _isInJAR() {
    return this._installLocation == SEARCH_JAR;
  },
  get _isInAppDir() {
    return this._installLocation == SEARCH_APP_DIR;
  },
  get _isInProfile() {
    return this._installLocation == SEARCH_PROFILE_DIR;
  },

  get _isDefault() {
    // For now, our concept of a "default engine" is "one that is not in the
    // user's profile directory", which is currently equivalent to "is app- or
    // extension-shipped".
    return !this._isInProfile;
  },

  get _hasUpdates() {
    // Whether or not the engine has an update URL
    let selfURL = this._getURLOfType(URLTYPE_OPENSEARCH);
    return !!(this._updateURL || this._iconUpdateURL || (selfURL &&
              selfURL._hasRelation("self")));
  },

  get name() {
    return this._name;
  },

  get type() {
    return this._type;
  },

  get searchForm() {
    if (!this._searchForm) {
      // No searchForm specified in the engine definition file, use the prePath
      // (e.g. https://foo.com for https://foo.com/search.php?q=bar).
      var htmlUrl = this._getURLOfType(URLTYPE_SEARCH_HTML);
      ENSURE_WARN(htmlUrl, "Engine has no HTML URL!", Cr.NS_ERROR_UNEXPECTED);
      this._searchForm = makeURI(htmlUrl.template).prePath;
    }

    return ParamSubstitution(this._searchForm, "", this);
  },

  get queryCharset() {
    if (this._queryCharset)
      return this._queryCharset;
    return this._queryCharset = queryCharsetFromCode(/* get the default */);
  },

  // from nsISearchEngine
  addParam: function SRCH_ENG_addParam(aName, aValue, aResponseType) {
    if (!aName || (aValue == null))
      FAIL("missing name or value for nsISearchEngine::addParam!");
    ENSURE_WARN(!this._readOnly,
                "called nsISearchEngine::addParam on a read-only engine!",
                Cr.NS_ERROR_FAILURE);
    if (!aResponseType)
      aResponseType = URLTYPE_SEARCH_HTML;

    var url = this._getURLOfType(aResponseType);
    if (!url)
      FAIL("Engine object has no URL for response type " + aResponseType,
           Cr.NS_ERROR_FAILURE);

    url.addParam(aName, aValue);

    // Serialize the changes to file lazily
    this.lazySerializeTask.start();
  },

#ifdef ANDROID
  get _defaultMobileResponseType() {
    let type = URLTYPE_SEARCH_HTML;

    let sysInfo = Cc["@mozilla.org/system-info;1"].getService(Ci.nsIPropertyBag2);
    let isTablet = sysInfo.get("tablet");
    if (isTablet && this.supportsResponseType("application/x-moz-tabletsearch")) {
      // Check for a tablet-specific search URL override
      type = "application/x-moz-tabletsearch";
    } else if (!isTablet && this.supportsResponseType("application/x-moz-phonesearch")) {
      // Check for a phone-specific search URL override
      type = "application/x-moz-phonesearch";
    }

    delete this._defaultMobileResponseType;
    return this._defaultMobileResponseType = type;
  },
#endif

  // from nsISearchEngine
  getSubmission: function SRCH_ENG_getSubmission(aData, aResponseType, aPurpose) {
#ifdef ANDROID
    if (!aResponseType) {
      aResponseType = this._defaultMobileResponseType;
    }
#endif
    if (!aResponseType) {
      aResponseType = URLTYPE_SEARCH_HTML;
    }

    var url = this._getURLOfType(aResponseType);

    if (!url)
      return null;

    if (!aData) {
      // Return a dummy submission object with our searchForm attribute
      return new Submission(makeURI(this.searchForm), null);
    }

    LOG("getSubmission: In data: \"" + aData + "\"; Purpose: \"" + aPurpose + "\"");
    var textToSubURI = Cc["@mozilla.org/intl/texttosuburi;1"].
                       getService(Ci.nsITextToSubURI);
    var data = "";
    try {
      data = textToSubURI.ConvertAndEscape(this.queryCharset, aData);
    } catch (ex) {
      LOG("getSubmission: Falling back to default queryCharset!");
      data = textToSubURI.ConvertAndEscape(DEFAULT_QUERY_CHARSET, aData);
    }
    LOG("getSubmission: Out data: \"" + data + "\"");
    return url.getSubmission(data, this, aPurpose);
  },

  // from nsISearchEngine
  supportsResponseType: function SRCH_ENG_supportsResponseType(type) {
    return (this._getURLOfType(type) != null);
  },

  // nsISupports
  QueryInterface: function SRCH_ENG_QI(aIID) {
    if (aIID.equals(Ci.nsISearchEngine) ||
        aIID.equals(Ci.nsISupports))
      return this;
    throw Cr.NS_ERROR_NO_INTERFACE;
  },

  get wrappedJSObject() {
    return this;
  },

  /**
   * Returns a string with the URL to an engine's icon matching both width and
   * height. Returns null if icon with specified dimensions is not found.
   *
   * @param width
   *        Width of the requested icon.
   * @param height
   *        Height of the requested icon.
   */
  getIconURLBySize: function SRCH_ENG_getIconURLBySize(aWidth, aHeight) {
    if (!this._iconMapObj)
      return null;

    let key = this._getIconKey(aWidth, aHeight);
    if (key in this._iconMapObj) {
      return this._iconMapObj[key];
    }
    return null;
  },

  /**
   * Gets an array of all available icons. Each entry is an object with
   * width, height and url properties. width and height are numeric and
   * represent the icon's dimensions. url is a string with the URL for
   * the icon.
   */
  getIcons: function SRCH_ENG_getIcons() {
    let result = [];

    if (!this._iconMapObj)
      return result;

    for (let key of Object.keys(this._iconMapObj)) {
      let iconSize = JSON.parse(key);
      result.push({
        width: iconSize.width,
        height: iconSize.height,
        url: this._iconMapObj[key]
      });
    }

    return result;
  }
};

// nsISearchSubmission
function Submission(aURI, aPostData = null) {
  this._uri = aURI;
  this._postData = aPostData;
}
Submission.prototype = {
  get uri() {
    return this._uri;
  },
  get postData() {
    return this._postData;
  },
  QueryInterface: function SRCH_SUBM_QI(aIID) {
    if (aIID.equals(Ci.nsISearchSubmission) ||
        aIID.equals(Ci.nsISupports))
      return this;
    throw Cr.NS_ERROR_NO_INTERFACE;
  }
}

function executeSoon(func) {
  Services.tm.mainThread.dispatch(func, Ci.nsIThread.DISPATCH_NORMAL);
}

/**
 * Check for sync initialization has completed or not.
 *
 * @param {aPromise} A promise.
 *
 * @returns the value returned by the invoked method.
 * @throws NS_ERROR_ALREADY_INITIALIZED if sync initialization has completed.
 */
function checkForSyncCompletion(aPromise) {
  return aPromise.then(function(aValue) {
    if (gInitialized) {
      throw Components.Exception("Synchronous fallback was called and has " +
                                 "finished so no need to pursue asynchronous " +
                                 "initialization",
                                 Cr.NS_ERROR_ALREADY_INITIALIZED);
    }
    return aValue;
  });
}

// nsIBrowserSearchService
function SearchService() {
  // Replace empty LOG function with the useful one if the log pref is set.
  if (getBoolPref(BROWSER_SEARCH_PREF + "log", false))
    LOG = DO_LOG;

  this._initObservers = Promise.defer();
}

SearchService.prototype = {
  classID: Components.ID("{7319788a-fe93-4db3-9f39-818cf08f4256}"),

  // The current status of initialization. Note that it does not determine if
  // initialization is complete, only if an error has been encountered so far.
  _initRV: Cr.NS_OK,

  // The boolean indicates that the initialization has started or not.
  _initStarted: null,

  // If initialization has not been completed yet, perform synchronous
  // initialization.
  // Throws in case of initialization error.
  _ensureInitialized: function  SRCH_SVC__ensureInitialized() {
    if (gInitialized) {
      if (!Components.isSuccessCode(this._initRV)) {
        LOG("_ensureInitialized: failure");
        throw this._initRV;
      }
      return;
    }

    let warning =
      "Search service falling back to synchronous initialization. " +
      "This is generally the consequence of an add-on using a deprecated " +
      "search service API.";
    // Bug 785487 - Disable warning until our own callers are fixed.
    //Deprecated.warning(warning, "https://developer.mozilla.org/en-US/docs/XPCOM_Interface_Reference/nsIBrowserSearchService#async_warning");
    LOG(warning);

    engineMetadataService.syncInit();
    this._syncInit();
    if (!Components.isSuccessCode(this._initRV)) {
      throw this._initRV;
    }
  },

  // Synchronous implementation of the initializer.
  // Used by |_ensureInitialized| as a fallback if initialization is not
  // complete.
  _syncInit: function SRCH_SVC__syncInit() {
    LOG("_syncInit start");
    this._initStarted = true;
    try {
      this._syncLoadEngines();
    } catch (ex) {
      this._initRV = Cr.NS_ERROR_FAILURE;
      LOG("_syncInit: failure loading engines: " + ex);
    }
    this._addObservers();

    gInitialized = true;

    this._initObservers.resolve(this._initRV);

    Services.obs.notifyObservers(null, SEARCH_SERVICE_TOPIC, "init-complete");

    LOG("_syncInit end");
  },

  /**
   * Asynchronous implementation of the initializer.
   *
   * @returns {Promise} A promise, resolved successfully if the initialization
   * succeeds.
   */
  _asyncInit: function SRCH_SVC__asyncInit() {
    return TaskUtils.spawn(function() {
      LOG("_asyncInit start");
      try {
        yield checkForSyncCompletion(this._asyncLoadEngines());
      } catch (ex if ex.result != Cr.NS_ERROR_ALREADY_INITIALIZED) {
        this._initRV = Cr.NS_ERROR_FAILURE;
        LOG("_asyncInit: failure loading engines: " + ex);
      }
      this._addObservers();
      gInitialized = true;
      this._initObservers.resolve(this._initRV);
      Services.obs.notifyObservers(null, SEARCH_SERVICE_TOPIC, "init-complete");
      LOG("_asyncInit: Completed _asyncInit");
    }.bind(this));
  },


  _engines: { },
  __sortedEngines: null,
  get _sortedEngines() {
    if (!this.__sortedEngines)
      return this._buildSortedEngineList();
    return this.__sortedEngines;
  },

  // Get the original Engine object that belongs to the defaultenginename pref
  // of the default branch.
  get _originalDefaultEngine() {
    let defaultPrefB = Services.prefs.getDefaultBranch(BROWSER_SEARCH_PREF);
    let nsIPLS = Ci.nsIPrefLocalizedString;
    let defaultEngine;
    try {
      defaultEngine = defaultPrefB.getComplexValue("defaultenginename", nsIPLS).data;
    } catch (ex) {
      // If the default pref is invalid (e.g. an add-on set it to a bogus value)
      // getEngineByName will just return null, which is the best we can do.
    }
    return this.getEngineByName(defaultEngine);
  },

  _buildCache: function SRCH_SVC__buildCache() {
    if (!getBoolPref(BROWSER_SEARCH_PREF + "cache.enabled", true))
      return;

    TelemetryStopwatch.start("SEARCH_SERVICE_BUILD_CACHE_MS");
    let cache = {};
    let locale = getLocale();
    let buildID = Services.appinfo.platformBuildID;

    // Allows us to force a cache refresh should the cache format change.
    cache.version = CACHE_VERSION;
    // We don't want to incur the costs of stat()ing each plugin on every
    // startup when the only (supported) time they will change is during
    // runtime (where we refresh for changes through the API) and app updates
    // (where the buildID is obviously going to change).
    // Extension-shipped plugins are the only exception to this, but their
    // directories are blown away during updates, so we'll detect their changes.
    cache.buildID = buildID;
    cache.locale = locale;

    cache.directories = {};

    function getParent(engine) {
      if (engine._file)
        return engine._file.parent;

      let uri = engine._uri;
      if (!uri.schemeIs("chrome")) {
        LOG("getParent: engine URI must be a chrome URI if it has no file");
        return null;
      }

      // use the underlying JAR file, for chrome URIs
      try {
        uri = gChromeReg.convertChromeURL(uri);
        if (uri instanceof Ci.nsINestedURI)
          uri = uri.innermostURI;
        uri.QueryInterface(Ci.nsIFileURL)

        return uri.file;
      } catch (ex) {
        LOG("getParent: couldn't map chrome:// URI to a file: " + ex)
      }

      return null;
    }

    for each (let engine in this._engines) {
      let parent = getParent(engine);
      if (!parent) {
        LOG("Error: no parent for engine " + engine._location + ", failing to cache it");

        continue;
      }

      let cacheKey = parent.path;
      if (!cache.directories[cacheKey]) {
        let cacheEntry = {};
        cacheEntry.lastModifiedTime = parent.lastModifiedTime;
        cacheEntry.engines = [];
        cache.directories[cacheKey] = cacheEntry;
      }
      cache.directories[cacheKey].engines.push(engine._serializeToJSON(true));
    }

    try {
      LOG("_buildCache: Writing to cache file.");
      let path = OS.Path.join(OS.Constants.Path.profileDir, "search.json");
      let data = gEncoder.encode(JSON.stringify(cache));
      let promise = OS.File.writeAtomic(path, data, { tmpPath: path + ".tmp"});

      promise.then(
        function onSuccess() {
          Services.obs.notifyObservers(null, SEARCH_SERVICE_TOPIC, SEARCH_SERVICE_CACHE_WRITTEN);
        },
        function onError(e) {
          LOG("_buildCache: failure during writeAtomic: " + e);
        }
      );
    } catch (ex) {
      LOG("_buildCache: Could not write to cache file: " + ex);
    }
    TelemetryStopwatch.finish("SEARCH_SERVICE_BUILD_CACHE_MS");
  },

  _syncLoadEngines: function SRCH_SVC__syncLoadEngines() {
    LOG("_syncLoadEngines: start");
    // See if we have a cache file so we don't have to parse a bunch of XML.
    let cache = {};
    let cacheEnabled = getBoolPref(BROWSER_SEARCH_PREF + "cache.enabled", true);
    if (cacheEnabled) {
      let cacheFile = getDir(NS_APP_USER_PROFILE_50_DIR);
      cacheFile.append("search.json");
      if (cacheFile.exists())
        cache = this._readCacheFile(cacheFile);
    }

    let loadDirs = [];
    let locations = getDir(NS_APP_SEARCH_DIR_LIST, Ci.nsISimpleEnumerator);
    while (locations.hasMoreElements()) {
      let dir = locations.getNext().QueryInterface(Ci.nsIFile);
      if (dir.directoryEntries.hasMoreElements())
        loadDirs.push(dir);
    }

    let loadFromJARs = getBoolPref(BROWSER_SEARCH_PREF + "loadFromJars", false);
    let chromeURIs = [];
    let chromeFiles = [];
    if (loadFromJARs)
      [chromeFiles, chromeURIs] = this._findJAREngines();

    let toLoad = chromeFiles.concat(loadDirs);

    function modifiedDir(aDir) {
      return (!cache.directories || !cache.directories[aDir.path] ||
              cache.directories[aDir.path].lastModifiedTime != aDir.lastModifiedTime);
    }

    function notInCachePath(aPathToLoad)
      cachePaths.indexOf(aPathToLoad.path) == -1;

    let buildID = Services.appinfo.platformBuildID;
    let cachePaths = [path for (path in cache.directories)];

    let rebuildCache = !cache.directories ||
                       cache.version != CACHE_VERSION ||
                       cache.locale != getLocale() ||
                       cache.buildID != buildID ||
                       cachePaths.length != toLoad.length ||
                       toLoad.some(notInCachePath) ||
                       toLoad.some(modifiedDir);

    if (!cacheEnabled || rebuildCache) {
      LOG("_loadEngines: Absent or outdated cache. Loading engines from disk.");
      loadDirs.forEach(this._loadEnginesFromDir, this);

      this._loadFromChromeURLs(chromeURIs);

      if (cacheEnabled)
        this._buildCache();
      return;
    }

    LOG("_loadEngines: loading from cache directories");
    for each (let dir in cache.directories)
      this._loadEnginesFromCache(dir);

    LOG("_loadEngines: done");
  },

  /**
   * Loads engines asynchronously.
   *
   * @returns {Promise} A promise, resolved successfully if loading data
   * succeeds.
   */
  _asyncLoadEngines: function SRCH_SVC__asyncLoadEngines() {
    return TaskUtils.spawn(function() {
      LOG("_asyncLoadEngines: start");
      // See if we have a cache file so we don't have to parse a bunch of XML.
      let cache = {};
      let cacheEnabled = getBoolPref(BROWSER_SEARCH_PREF + "cache.enabled", true);
      if (cacheEnabled) {
        let cacheFilePath = OS.Path.join(OS.Constants.Path.profileDir, "search.json");
        cache = yield checkForSyncCompletion(this._asyncReadCacheFile(cacheFilePath));
      }

      // Add all the non-empty directories of NS_APP_SEARCH_DIR_LIST to
      // loadDirs.
      let loadDirs = [];
      let locations = getDir(NS_APP_SEARCH_DIR_LIST, Ci.nsISimpleEnumerator);
      while (locations.hasMoreElements()) {
        let dir = locations.getNext().QueryInterface(Ci.nsIFile);
        let iterator = new OS.File.DirectoryIterator(dir.path,
                                                     { winPattern: "*.xml" });
        try {
          // Add dir to loadDirs if it contains any files.
          yield checkForSyncCompletion(iterator.next());
          loadDirs.push(dir);
        } catch (ex if ex.result != Cr.NS_ERROR_ALREADY_INITIALIZED) {
          // Catch for StopIteration exception.
        } finally {
          iterator.close();
        }
      }

      let loadFromJARs = getBoolPref(BROWSER_SEARCH_PREF + "loadFromJars", false);
      let chromeURIs = [];
      let chromeFiles = [];
      if (loadFromJARs) {
        Services.obs.notifyObservers(null, SEARCH_SERVICE_TOPIC, "find-jar-engines");
        [chromeFiles, chromeURIs] =
          yield checkForSyncCompletion(this._asyncFindJAREngines());
      }

      let toLoad = chromeFiles.concat(loadDirs);
      function hasModifiedDir(aList) {
        return TaskUtils.spawn(function() {
          let modifiedDir = false;

          for (let dir of aList) {
            if (!cache.directories || !cache.directories[dir.path]) {
              modifiedDir = true;
              break;
            }

            let info = yield OS.File.stat(dir.path);
            if (cache.directories[dir.path].lastModifiedTime !=
                info.lastModificationDate.getTime()) {
              modifiedDir = true;
              break;
            }
          }
          throw new Task.Result(modifiedDir);
        });
      }

      function notInCachePath(aPathToLoad)
        cachePaths.indexOf(aPathToLoad.path) == -1;

      let buildID = Services.appinfo.platformBuildID;
      let cachePaths = [path for (path in cache.directories)];

      let rebuildCache = !cache.directories ||
                         cache.version != CACHE_VERSION ||
                         cache.locale != getLocale() ||
                         cache.buildID != buildID ||
                         cachePaths.length != toLoad.length ||
                         toLoad.some(notInCachePath) ||
                         (yield checkForSyncCompletion(hasModifiedDir(toLoad)));

      if (!cacheEnabled || rebuildCache) {
        LOG("_asyncLoadEngines: Absent or outdated cache. Loading engines from disk.");
        let engines = [];
        for (let loadDir of loadDirs) {
          let enginesFromDir =
            yield checkForSyncCompletion(this._asyncLoadEnginesFromDir(loadDir));
          engines = engines.concat(enginesFromDir);
        }
        let enginesFromURLs =
           yield checkForSyncCompletion(this._asyncLoadFromChromeURLs(chromeURIs));
        engines = engines.concat(enginesFromURLs);

        for (let engine of engines) {
          this._addEngineToStore(engine);
        }
        if (cacheEnabled)
          this._buildCache();
        return;
      }

      LOG("_asyncLoadEngines: loading from cache directories");
      for each (let dir in cache.directories)
        this._loadEnginesFromCache(dir);

      LOG("_asyncLoadEngines: done");
    }.bind(this));
  },

  _readCacheFile: function SRCH_SVC__readCacheFile(aFile) {
    let stream = Cc["@mozilla.org/network/file-input-stream;1"].
                 createInstance(Ci.nsIFileInputStream);
    let json = Cc["@mozilla.org/dom/json;1"].createInstance(Ci.nsIJSON);

    try {
      stream.init(aFile, MODE_RDONLY, PERMS_FILE, 0);
      return json.decodeFromStream(stream, stream.available());
    } catch (ex) {
      LOG("_readCacheFile: Error reading cache file: " + ex);
    } finally {
      stream.close();
    }
    return false;
  },

  /**
   * Read from a given cache file asynchronously.
   *
   * @param aPath the file path.
   *
   * @returns {Promise} A promise, resolved successfully if retrieveing data
   * succeeds.
   */
  _asyncReadCacheFile: function SRCH_SVC__asyncReadCacheFile(aPath) {
    return TaskUtils.spawn(function() {
      let json;
      try {
        let bytes = yield OS.File.read(aPath);
        json = JSON.parse(new TextDecoder().decode(bytes));
      } catch (ex) {
        LOG("_asyncReadCacheFile: Error reading cache file: " + ex);
        json = {};
      }
      throw new Task.Result(json);
    });
  },

  _batchTask: null,
  get batchTask() {
    if (!this._batchTask) {
      let task = function taskCallback() {
        LOG("batchTask: Invalidating engine cache");
        this._buildCache();
      }.bind(this);
      this._batchTask = new DeferredTask(task, CACHE_INVALIDATION_DELAY);
    }
    return this._batchTask;
  },

  _addEngineToStore: function SRCH_SVC_addEngineToStore(aEngine) {
    LOG("_addEngineToStore: Adding engine: \"" + aEngine.name + "\"");

    // See if there is an existing engine with the same name. However, if this
    // engine is updating another engine, it's allowed to have the same name.
    var hasSameNameAsUpdate = (aEngine._engineToUpdate &&
                               aEngine.name == aEngine._engineToUpdate.name);
    if (aEngine.name in this._engines && !hasSameNameAsUpdate) {
      LOG("_addEngineToStore: Duplicate engine found, aborting!");
      return;
    }

    if (aEngine._engineToUpdate) {
      // We need to replace engineToUpdate with the engine that just loaded.
      var oldEngine = aEngine._engineToUpdate;

      // Remove the old engine from the hash, since it's keyed by name, and our
      // name might change (the update might have a new name).
      delete this._engines[oldEngine.name];

      // Hack: we want to replace the old engine with the new one, but since
      // people may be holding refs to the nsISearchEngine objects themselves,
      // we'll just copy over all "private" properties (those without a getter
      // or setter) from one object to the other.
      for (var p in aEngine) {
        if (!(aEngine.__lookupGetter__(p) || aEngine.__lookupSetter__(p)))
          oldEngine[p] = aEngine[p];
      }
      aEngine = oldEngine;
      aEngine._engineToUpdate = null;

      // Add the engine back
      this._engines[aEngine.name] = aEngine;
      notifyAction(aEngine, SEARCH_ENGINE_CHANGED);
    } else {
      // Not an update, just add the new engine.
      this._engines[aEngine.name] = aEngine;
      // Only add the engine to the list of sorted engines if the initial list
      // has already been built (i.e. if this.__sortedEngines is non-null). If
      // it hasn't, we're loading engines from disk and the sorted engine list
      // will be built once we need it.
      if (this.__sortedEngines) {
        this.__sortedEngines.push(aEngine);
        this._saveSortedEngineList();
      }
      notifyAction(aEngine, SEARCH_ENGINE_ADDED);
    }

    if (aEngine._hasUpdates) {
      // Schedule the engine's next update, if it isn't already.
      if (!engineMetadataService.getAttr(aEngine, "updateexpir"))
        engineUpdateService.scheduleNextUpdate(aEngine);
  
      // We need to save the engine's _dataType, if this is the first time the
      // engine is added to the dataStore, since ._dataType isn't persisted
      // and will change on the next startup (since the engine will then be
      // XML). We need this so that we know how to load any future updates from
      // this engine.
      if (!engineMetadataService.getAttr(aEngine, "updatedatatype"))
        engineMetadataService.setAttr(aEngine, "updatedatatype",
                                      aEngine._dataType);
    }
  },

  _loadEnginesFromCache: function SRCH_SVC__loadEnginesFromCache(aDir) {
    let engines = aDir.engines;
    LOG("_loadEnginesFromCache: Loading from cache. " + engines.length + " engines to load.");
    for (let i = 0; i < engines.length; i++) {
      let json = engines[i];

      try {
        let engine;
        if (json.filePath)
          engine = new Engine({type: "filePath", value: json.filePath}, json._dataType,
                               json._readOnly);
        else if (json._url)
          engine = new Engine({type: "uri", value: json._url}, json._dataType, json._readOnly);

        engine._initWithJSON(json);
        this._addEngineToStore(engine);
      } catch (ex) {
        LOG("Failed to load " + engines[i]._name + " from cache: " + ex);
        LOG("Engine JSON: " + engines[i].toSource());
      }
    }
  },

  _loadEnginesFromDir: function SRCH_SVC__loadEnginesFromDir(aDir) {
    LOG("_loadEnginesFromDir: Searching in " + aDir.path + " for search engines.");

    // Check whether aDir is the user profile dir
    var isInProfile = aDir.equals(getDir(NS_APP_USER_SEARCH_DIR));

    var files = aDir.directoryEntries
                    .QueryInterface(Ci.nsIDirectoryEnumerator);

    while (files.hasMoreElements()) {
      var file = files.nextFile;

      // Ignore hidden and empty files, and directories
      if (!file.isFile() || file.fileSize == 0 || file.isHidden())
        continue;

      var fileURL = NetUtil.ioService.newFileURI(file).QueryInterface(Ci.nsIURL);
      var fileExtension = fileURL.fileExtension.toLowerCase();
      var isWritable = isInProfile && file.isWritable();

      if (fileExtension != "xml") {
        // Not an engine
        continue;
      }

      var addedEngine = null;
      try {
        addedEngine = new Engine(file, SEARCH_DATA_XML, !isWritable);
        addedEngine._initFromFile();
      } catch (ex) {
        LOG("_loadEnginesFromDir: Failed to load " + file.path + "!\n" + ex);
        continue;
      }

      this._addEngineToStore(addedEngine);
    }
  },

  /**
   * Loads engines from a given directory asynchronously.
   *
   * @param aDir the directory.
   *
   * @returns {Promise} A promise, resolved successfully if retrieveing data
   * succeeds.
   */
  _asyncLoadEnginesFromDir: function SRCH_SVC__asyncLoadEnginesFromDir(aDir) {
    LOG("_asyncLoadEnginesFromDir: Searching in " + aDir.path + " for search engines.");

    // Check whether aDir is the user profile dir
    let isInProfile = aDir.equals(getDir(NS_APP_USER_SEARCH_DIR));
    let iterator = new OS.File.DirectoryIterator(aDir.path);
    return TaskUtils.spawn(function() {
      let osfiles = yield iterator.nextBatch();
      iterator.close();

      let engines = [];
      for (let osfile of osfiles) {
        if (osfile.isDir || osfile.isSymLink)
          continue;

        let fileInfo = yield OS.File.stat(osfile.path);
        if (fileInfo.size == 0)
          continue;

        let parts = osfile.path.split(".");
        if (parts.length <= 1 || (parts.pop()).toLowerCase() != "xml") {
          // Not an engine
          continue;
        }

        let addedEngine = null;
        try {
          let file = new FileUtils.File(osfile.path);
          let isWritable = isInProfile;
          addedEngine = new Engine(file, SEARCH_DATA_XML, !isWritable);
          yield checkForSyncCompletion(addedEngine._asyncInitFromFile());
        } catch (ex if ex.result != Cr.NS_ERROR_ALREADY_INITIALIZED) {
          LOG("_asyncLoadEnginesFromDir: Failed to load " + file.path + "!\n" + ex);
          continue;
        }
        engines.push(addedEngine);
      }
      throw new Task.Result(engines);
    }.bind(this));
  },

  _loadFromChromeURLs: function SRCH_SVC_loadFromChromeURLs(aURLs) {
    aURLs.forEach(function (url) {
      try {
        LOG("_loadFromChromeURLs: loading engine from chrome url: " + url);

        let engine = new Engine(makeURI(url), SEARCH_DATA_XML, true);

        engine._initFromURISync();

        this._addEngineToStore(engine);
      } catch (ex) {
        LOG("_loadFromChromeURLs: failed to load engine: " + ex);
      }
    }, this);
  },

  /**
   * Loads engines from Chrome URLs asynchronously.
   *
   * @param aURLs a list of URLs.
   *
   * @returns {Promise} A promise, resolved successfully if loading data
   * succeeds.
   */
  _asyncLoadFromChromeURLs: function SRCH_SVC__asyncLoadFromChromeURLs(aURLs) {
    return TaskUtils.spawn(function() {
      let engines = [];
      for (let url of aURLs) {
        try {
          LOG("_asyncLoadFromChromeURLs: loading engine from chrome url: " + url);
          let engine = new Engine(NetUtil.newURI(url), SEARCH_DATA_XML, true);
          yield checkForSyncCompletion(engine._asyncInitFromURI());
          engines.push(engine);
        } catch (ex if ex.result != Cr.NS_ERROR_ALREADY_INITIALIZED) {
          LOG("_asyncLoadFromChromeURLs: failed to load engine: " + ex);
        }
      }
      throw new Task.Result(engines);
    }.bind(this));
  },

  _findJAREngines: function SRCH_SVC_findJAREngines() {
    LOG("_findJAREngines: looking for engines in JARs")

    let rootURIPref = ""
    try {
      rootURIPref = Services.prefs.getCharPref(BROWSER_SEARCH_PREF + "jarURIs");
    } catch (ex) {}

    if (!rootURIPref) {
      LOG("_findJAREngines: no JAR URIs were specified");

      return [[], []];
    }

    let rootURIs = rootURIPref.split(",");
    let uris = [];
    let chromeFiles = [];

    rootURIs.forEach(function (root) {
      // Find the underlying JAR file for this chrome package (_loadEngines uses
      // it to determine whether it needs to invalidate the cache)
      let chromeFile;
      try {
        let chromeURI = gChromeReg.convertChromeURL(makeURI(root));
        let fileURI = chromeURI; // flat packaging
        while (fileURI instanceof Ci.nsIJARURI)
          fileURI = fileURI.JARFile; // JAR packaging
        fileURI.QueryInterface(Ci.nsIFileURL);
        chromeFile = fileURI.file;
      } catch (ex) {
        LOG("_findJAREngines: failed to get chromeFile for " + root + ": " + ex);
      }

      if (!chromeFile)
        return;

      chromeFiles.push(chromeFile);

      // Read list.txt from the chrome package to find the engines we need to
      // load
      let listURL = root + "list.txt";
      let names = [];
      try {
        let chan = NetUtil.ioService.newChannelFromURI(makeURI(listURL));
        let sis = Cc["@mozilla.org/scriptableinputstream;1"].
                  createInstance(Ci.nsIScriptableInputStream);
        sis.init(chan.open());
        let list = sis.read(sis.available());
        names = list.split("\n").filter(function (n) !!n);
      } catch (ex) {
        LOG("_findJAREngines: failed to retrieve list.txt from " + listURL + ": " + ex);

        return;
      }

      names.forEach(function (n) uris.push(root + n + ".xml"));
    });
    
    return [chromeFiles, uris];
  },

  /**
   * Loads jar engines asynchronously.
   *
   * @returns {Promise} A promise, resolved successfully if finding jar engines
   * succeeds.
   */
  _asyncFindJAREngines: function SRCH_SVC__asyncFindJAREngines() {
    return TaskUtils.spawn(function() {
      LOG("_asyncFindJAREngines: looking for engines in JARs")

      let rootURIPref = "";
      try {
        rootURIPref = Services.prefs.getCharPref(BROWSER_SEARCH_PREF + "jarURIs");
      } catch (ex) {}

      if (!rootURIPref) {
        LOG("_asyncFindJAREngines: no JAR URIs were specified");
        throw new Task.Result([[], []]);
      }

      let rootURIs = rootURIPref.split(",");
      let uris = [];
      let chromeFiles = [];

      for (let root of rootURIs) {
        // Find the underlying JAR file for this chrome package (_loadEngines uses
        // it to determine whether it needs to invalidate the cache)
        let chromeFile;
        try {
          let chromeURI = gChromeReg.convertChromeURL(makeURI(root));
          let fileURI = chromeURI; // flat packaging
          while (fileURI instanceof Ci.nsIJARURI)
            fileURI = fileURI.JARFile; // JAR packaging
          fileURI.QueryInterface(Ci.nsIFileURL);
          chromeFile = fileURI.file;
        } catch (ex) {
          LOG("_asyncFindJAREngines: failed to get chromeFile for " + root + ": " + ex);
        }

        if (!chromeFile) {
          return;
        }

        chromeFiles.push(chromeFile);

        // Read list.txt from the chrome package to find the engines we need to
        // load
        let listURL = root + "list.txt";
        let deferred = Promise.defer();
        let request = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"].
                        createInstance(Ci.nsIXMLHttpRequest);
        request.onload = function(aEvent) {
          deferred.resolve(aEvent.target.responseText);
        };
        request.onerror = function(aEvent) {
          LOG("_asyncFindJAREngines: failed to retrieve list.txt from " + listURL);
          deferred.resolve("");
        };
        request.open("GET", NetUtil.newURI(listURL).spec, true);
        request.send();
        let list = yield deferred.promise;

        let names = [];
        names = list.split("\n").filter(function (n) !!n);
        names.forEach(function (n) uris.push(root + n + ".xml"));
      }
      throw new Task.Result([chromeFiles, uris]);
    });
  },


  _saveSortedEngineList: function SRCH_SVC_saveSortedEngineList() {
    LOG("SRCH_SVC_saveSortedEngineList: starting");

    // Set the useDB pref to indicate that from now on we should use the order
    // information stored in the database.
    Services.prefs.setBoolPref(BROWSER_SEARCH_PREF + "useDBForOrder", true);

    var engines = this._getSortedEngines(true);

    let instructions = [];
    for (var i = 0; i < engines.length; ++i) {
      instructions.push(
        {key: "order",
         value: i+1,
         engine: engines[i]
        });
    }

    engineMetadataService.setAttrs(instructions);
    LOG("SRCH_SVC_saveSortedEngineList: done");
  },

  _buildSortedEngineList: function SRCH_SVC_buildSortedEngineList() {
    LOG("_buildSortedEngineList: building list");
    var addedEngines = { };
    this.__sortedEngines = [];
    var engine;

    // If the user has specified a custom engine order, read the order
    // information from the engineMetadataService instead of the default
    // prefs.
    if (getBoolPref(BROWSER_SEARCH_PREF + "useDBForOrder", false)) {
      LOG("_buildSortedEngineList: using db for order");

      // Flag to keep track of whether or not we need to call _saveSortedEngineList. 
      let needToSaveEngineList = false;

      for each (engine in this._engines) {
        var orderNumber = engineMetadataService.getAttr(engine, "order");

        // Since the DB isn't regularly cleared, and engine files may disappear
        // without us knowing, we may already have an engine in this slot. If
        // that happens, we just skip it - it will be added later on as an
        // unsorted engine.
        if (orderNumber && !this.__sortedEngines[orderNumber-1]) {
          this.__sortedEngines[orderNumber-1] = engine;
          addedEngines[engine.name] = engine;
        } else {
          // We need to call _saveSortedEngineList so this gets sorted out.
          needToSaveEngineList = true;
        }
      }

      // Filter out any nulls for engines that may have been removed
      var filteredEngines = this.__sortedEngines.filter(function(a) { return !!a; });
      if (this.__sortedEngines.length != filteredEngines.length)
        needToSaveEngineList = true;
      this.__sortedEngines = filteredEngines;

      if (needToSaveEngineList)
        this._saveSortedEngineList();
    } else {
      // The DB isn't being used, so just read the engine order from the prefs
      var i = 0;
      var engineName;
      var prefName;

      try {
        var extras =
          Services.prefs.getChildList(BROWSER_SEARCH_PREF + "order.extra.");

        for each (prefName in extras) {
          engineName = Services.prefs.getCharPref(prefName);

          engine = this._engines[engineName];
          if (!engine || engine.name in addedEngines)
            continue;

          this.__sortedEngines.push(engine);
          addedEngines[engine.name] = engine;
        }
      }
      catch (e) { }

      while (true) {
        engineName = getLocalizedPref(BROWSER_SEARCH_PREF + "order." + (++i));
        if (!engineName)
          break;

        engine = this._engines[engineName];
        if (!engine || engine.name in addedEngines)
          continue;
        
        this.__sortedEngines.push(engine);
        addedEngines[engine.name] = engine;
      }
    }

    // Array for the remaining engines, alphabetically sorted
    var alphaEngines = [];

    for each (engine in this._engines) {
      if (!(engine.name in addedEngines))
        alphaEngines.push(this._engines[engine.name]);
    }
    alphaEngines = alphaEngines.sort(function (a, b) {
                                       return a.name.localeCompare(b.name);
                                     });
    return this.__sortedEngines = this.__sortedEngines.concat(alphaEngines);
  },

  /**
   * Get a sorted array of engines.
   * @param aWithHidden
   *        True if hidden plugins should be included in the result.
   */
  _getSortedEngines: function SRCH_SVC_getSorted(aWithHidden) {
    if (aWithHidden)
      return this._sortedEngines;

    return this._sortedEngines.filter(function (engine) {
                                        return !engine.hidden;
                                      });
  },

  _setEngineByPref: function SRCH_SVC_setEngineByPref(aEngineType, aPref) {
    this._ensureInitialized();
    let newEngine = this.getEngineByName(getLocalizedPref(aPref, ""));
    if (!newEngine)
      FAIL("Can't find engine in store!", Cr.NS_ERROR_UNEXPECTED);

    this[aEngineType] = newEngine;
  },

  // nsIBrowserSearchService
  init: function SRCH_SVC_init(observer) {
    LOG("SearchService.init");
    let self = this;
    if (!this._initStarted) {
      TelemetryStopwatch.start("SEARCH_SERVICE_INIT_MS");
      this._initStarted = true;
      TaskUtils.spawn(function task() {
        try {
          yield checkForSyncCompletion(engineMetadataService.init());
          // Complete initialization by calling asynchronous initializer.
          yield self._asyncInit();
          TelemetryStopwatch.finish("SEARCH_SERVICE_INIT_MS");
        } catch (ex if ex.result == Cr.NS_ERROR_ALREADY_INITIALIZED) {
          // No need to pursue asynchronous because synchronous fallback was
          // called and has finished.
          TelemetryStopwatch.finish("SEARCH_SERVICE_INIT_MS");
        } catch (ex) {
          self._initObservers.reject(ex);
          TelemetryStopwatch.cancel("SEARCH_SERVICE_INIT_MS");
        }
      });
    }
    if (observer) {
      TaskUtils.captureErrors(this._initObservers.promise.then(
        function onSuccess() {
          observer.onInitComplete(self._initRV);
        },
        function onError(aReason) {
          Components.utils.reportError("Internal error while initializing SearchService: " + aReason);
          observer.onInitComplete(Components.results.NS_ERROR_UNEXPECTED);
        }
      ));
    }
  },

  get isInitialized() {
    return gInitialized;
  },

  getEngines: function SRCH_SVC_getEngines(aCount) {
    this._ensureInitialized();
    LOG("getEngines: getting all engines");
    var engines = this._getSortedEngines(true);
    aCount.value = engines.length;
    return engines;
  },

  getVisibleEngines: function SRCH_SVC_getVisible(aCount) {
    this._ensureInitialized();
    LOG("getVisibleEngines: getting all visible engines");
    var engines = this._getSortedEngines(false);
    aCount.value = engines.length;
    return engines;
  },

  getDefaultEngines: function SRCH_SVC_getDefault(aCount) {
    this._ensureInitialized();
    function isDefault(engine) {
      return engine._isDefault;
    };
    var engines = this._sortedEngines.filter(isDefault);
    var engineOrder = {};
    var engineName;
    var i = 1;

    // Build a list of engines which we have ordering information for.
    // We're rebuilding the list here because _sortedEngines contain the
    // current order, but we want the original order.

    // First, look at the "browser.search.order.extra" branch.
    try {
      var extras = Services.prefs.getChildList(BROWSER_SEARCH_PREF + "order.extra.");

      for each (var prefName in extras) {
        engineName = Services.prefs.getCharPref(prefName);

        if (!(engineName in engineOrder))
          engineOrder[engineName] = i++;
      }
    } catch (e) {
      LOG("Getting extra order prefs failed: " + e);
    }

    // Now look through the "browser.search.order" branch.
    for (var j = 1; ; j++) {
      engineName = getLocalizedPref(BROWSER_SEARCH_PREF + "order." + j);
      if (!engineName)
        break;

      if (!(engineName in engineOrder))
        engineOrder[engineName] = i++;
    }

    LOG("getDefaultEngines: engineOrder: " + engineOrder.toSource());

    function compareEngines (a, b) {
      var aIdx = engineOrder[a.name];
      var bIdx = engineOrder[b.name];

      if (aIdx && bIdx)
        return aIdx - bIdx;
      if (aIdx)
        return -1;
      if (bIdx)
        return 1;

      return a.name.localeCompare(b.name);
    }
    engines.sort(compareEngines);

    aCount.value = engines.length;
    return engines;
  },

  getEngineByName: function SRCH_SVC_getEngineByName(aEngineName) {
    this._ensureInitialized();
    return this._engines[aEngineName] || null;
  },

  getEngineByAlias: function SRCH_SVC_getEngineByAlias(aAlias) {
    this._ensureInitialized();
    for (var engineName in this._engines) {
      var engine = this._engines[engineName];
      if (engine && engine.alias == aAlias)
        return engine;
    }
    return null;
  },

  addEngineWithDetails: function SRCH_SVC_addEWD(aName, aIconURL, aAlias,
                                                 aDescription, aMethod,
                                                 aTemplate) {
    this._ensureInitialized();
    if (!aName)
      FAIL("Invalid name passed to addEngineWithDetails!");
    if (!aMethod)
      FAIL("Invalid method passed to addEngineWithDetails!");
    if (!aTemplate)
      FAIL("Invalid template passed to addEngineWithDetails!");
    if (this._engines[aName])
      FAIL("An engine with that name already exists!", Cr.NS_ERROR_FILE_ALREADY_EXISTS);

    var engine = new Engine(getSanitizedFile(aName), SEARCH_DATA_XML, false);
    engine._initFromMetadata(aName, aIconURL, aAlias, aDescription,
                             aMethod, aTemplate);
    this._addEngineToStore(engine);
    this.batchTask.start();
  },

  addEngine: function SRCH_SVC_addEngine(aEngineURL, aDataType, aIconURL,
                                         aConfirm, aCallback) {
    LOG("addEngine: Adding \"" + aEngineURL + "\".");
    this._ensureInitialized();
    try {
      var uri = makeURI(aEngineURL);
      var engine = new Engine(uri, aDataType, false);
      if (aCallback) {
        engine._installCallback = function (errorCode) {
          try {
            if (errorCode == null)
              aCallback.onSuccess(engine);
            else
              aCallback.onError(errorCode);
          } catch (ex) {
            Cu.reportError("Error invoking addEngine install callback: " + ex);
          }
          // Clear the reference to the callback now that it's been invoked.
          engine._installCallback = null;
        };
      }
      engine._initFromURIAndLoad();
    } catch (ex) {
      // Drop the reference to the callback, if set
      if (engine)
        engine._installCallback = null;
      FAIL("addEngine: Error adding engine:\n" + ex, Cr.NS_ERROR_FAILURE);
    }
    engine._setIcon(aIconURL, false);
    engine._confirm = aConfirm;
  },

  removeEngine: function SRCH_SVC_removeEngine(aEngine) {
    this._ensureInitialized();
    if (!aEngine)
      FAIL("no engine passed to removeEngine!");

    var engineToRemove = null;
    for (var e in this._engines) {
      if (aEngine.wrappedJSObject == this._engines[e])
        engineToRemove = this._engines[e];
    }

    if (!engineToRemove)
      FAIL("removeEngine: Can't find engine to remove!", Cr.NS_ERROR_FILE_NOT_FOUND);

    if (engineToRemove == this.currentEngine) {
      this._currentEngine = null;
    }

    if (engineToRemove == this.defaultEngine) {
      this._defaultEngine = null;
    }

    if (engineToRemove._readOnly) {
      // Just hide it (the "hidden" setter will notify) and remove its alias to
      // avoid future conflicts with other engines.
      engineToRemove.hidden = true;
      engineToRemove.alias = null;
    } else {
      // Cancel the serialized task if it's running
      if (engineToRemove._lazySerializeTask) {
        engineToRemove._lazySerializeTask.cancel();
        engineToRemove._lazySerializeTask = null;
      }

      // Remove the engine file from disk (this might throw)
      engineToRemove._remove();
      engineToRemove._file = null;

      // Remove the engine from _sortedEngines
      var index = this._sortedEngines.indexOf(engineToRemove);
      if (index == -1)
        FAIL("Can't find engine to remove in _sortedEngines!", Cr.NS_ERROR_FAILURE);
      this.__sortedEngines.splice(index, 1);

      // Remove the engine from the internal store
      delete this._engines[engineToRemove.name];

      notifyAction(engineToRemove, SEARCH_ENGINE_REMOVED);

      // Since we removed an engine, we need to update the preferences.
      this._saveSortedEngineList();
    }
  },

  moveEngine: function SRCH_SVC_moveEngine(aEngine, aNewIndex) {
    this._ensureInitialized();
    if ((aNewIndex > this._sortedEngines.length) || (aNewIndex < 0))
      FAIL("SRCH_SVC_moveEngine: Index out of bounds!");
    if (!(aEngine instanceof Ci.nsISearchEngine))
      FAIL("SRCH_SVC_moveEngine: Invalid engine passed to moveEngine!");
    if (aEngine.hidden)
      FAIL("moveEngine: Can't move a hidden engine!", Cr.NS_ERROR_FAILURE);

    var engine = aEngine.wrappedJSObject;

    var currentIndex = this._sortedEngines.indexOf(engine);
    if (currentIndex == -1)
      FAIL("moveEngine: Can't find engine to move!", Cr.NS_ERROR_UNEXPECTED);

    // Our callers only take into account non-hidden engines when calculating
    // aNewIndex, but we need to move it in the array of all engines, so we
    // need to adjust aNewIndex accordingly. To do this, we count the number
    // of hidden engines in the list before the engine that we're taking the
    // place of. We do this by first finding newIndexEngine (the engine that
    // we were supposed to replace) and then iterating through the complete 
    // engine list until we reach it, increasing aNewIndex for each hidden
    // engine we find on our way there.
    //
    // This could be further simplified by having our caller pass in
    // newIndexEngine directly instead of aNewIndex.
    var newIndexEngine = this._getSortedEngines(false)[aNewIndex];
    if (!newIndexEngine)
      FAIL("moveEngine: Can't find engine to replace!", Cr.NS_ERROR_UNEXPECTED);

    for (var i = 0; i < this._sortedEngines.length; ++i) {
      if (newIndexEngine == this._sortedEngines[i])
        break;
      if (this._sortedEngines[i].hidden)
        aNewIndex++;
    }

    if (currentIndex == aNewIndex)
      return; // nothing to do!

    // Move the engine
    var movedEngine = this.__sortedEngines.splice(currentIndex, 1)[0];
    this.__sortedEngines.splice(aNewIndex, 0, movedEngine);

    notifyAction(engine, SEARCH_ENGINE_CHANGED);

    // Since we moved an engine, we need to update the preferences.
    this._saveSortedEngineList();
  },

  restoreDefaultEngines: function SRCH_SVC_resetDefaultEngines() {
    this._ensureInitialized();
    for each (var e in this._engines) {
      // Unhide all default engines
      if (e.hidden && e._isDefault)
        e.hidden = false;
    }
  },

  get defaultEngine() {
    this._ensureInitialized();
    if (!this._defaultEngine) {
      let defPref = BROWSER_SEARCH_PREF + "defaultenginename";
      let defaultEngine = this.getEngineByName(getLocalizedPref(defPref, ""))
      if (!defaultEngine)
        defaultEngine = this._getSortedEngines(false)[0] || null;
      this._defaultEngine = defaultEngine;
    }
    if (this._defaultEngine.hidden)
      return this._getSortedEngines(false)[0];
    return this._defaultEngine;
  },

  set defaultEngine(val) {
    this._ensureInitialized();
    // Sometimes we get wrapped nsISearchEngine objects (external XPCOM callers),
    // and sometimes we get raw Engine JS objects (callers in this file), so
    // handle both.
    if (!(val instanceof Ci.nsISearchEngine) && !(val instanceof Engine))
      FAIL("Invalid argument passed to defaultEngine setter");

    let newDefaultEngine = this.getEngineByName(val.name);
    if (!newDefaultEngine)
      FAIL("Can't find engine in store!", Cr.NS_ERROR_UNEXPECTED);

    if (newDefaultEngine == this._defaultEngine)
      return;

    this._defaultEngine = newDefaultEngine;

    // Set a flag to keep track that this setter was called properly, not by
    // setting the pref alone.
    this._changingDefaultEngine = true;
    let defPref = BROWSER_SEARCH_PREF + "defaultenginename";
    // If we change the default engine in the future, that change should impact
    // users who have switched away from and then back to the build's "default"
    // engine. So clear the user pref when the defaultEngine is set to the
    // build's default engine, so that the defaultEngine getter falls back to
    // whatever the default is.
    if (this._defaultEngine == this._originalDefaultEngine) {
      Services.prefs.clearUserPref(defPref);
    }
    else {
      setLocalizedPref(defPref, this._defaultEngine.name);
    }
    this._changingDefaultEngine = false;

    notifyAction(this._defaultEngine, SEARCH_ENGINE_DEFAULT);
  },

  get currentEngine() {
    this._ensureInitialized();
    if (!this._currentEngine) {
      let selectedEngine = getLocalizedPref(BROWSER_SEARCH_PREF +
                                            "selectedEngine");
      this._currentEngine = this.getEngineByName(selectedEngine);
    }

    if (!this._currentEngine || this._currentEngine.hidden)
      this._currentEngine = this.defaultEngine;
    return this._currentEngine;
  },

  set currentEngine(val) {
    this._ensureInitialized();
    // Sometimes we get wrapped nsISearchEngine objects (external XPCOM callers),
    // and sometimes we get raw Engine JS objects (callers in this file), so
    // handle both.
    if (!(val instanceof Ci.nsISearchEngine) && !(val instanceof Engine))
      FAIL("Invalid argument passed to currentEngine setter");

    var newCurrentEngine = this.getEngineByName(val.name);
    if (!newCurrentEngine)
      FAIL("Can't find engine in store!", Cr.NS_ERROR_UNEXPECTED);

    if (newCurrentEngine == this._currentEngine)
      return;

    this._currentEngine = newCurrentEngine;

    var currentEnginePref = BROWSER_SEARCH_PREF + "selectedEngine";

    // Set a flag to keep track that this setter was called properly, not by
    // setting the pref alone.
    this._changingCurrentEngine = true;
    // If we change the default engine in the future, that change should impact
    // users who have switched away from and then back to the build's "default"
    // engine. So clear the user pref when the currentEngine is set to the
    // build's default engine, so that the currentEngine getter falls back to
    // whatever the default is.
    if (this._currentEngine == this._originalDefaultEngine) {
      Services.prefs.clearUserPref(currentEnginePref);
    }
    else {
      setLocalizedPref(currentEnginePref, this._currentEngine.name);
    }
    this._changingCurrentEngine = false;

    notifyAction(this._currentEngine, SEARCH_ENGINE_CURRENT);
  },

  // nsIObserver
  observe: function SRCH_SVC_observe(aEngine, aTopic, aVerb) {
    switch (aTopic) {
      case SEARCH_ENGINE_TOPIC:
        switch (aVerb) {
          case SEARCH_ENGINE_LOADED:
            var engine = aEngine.QueryInterface(Ci.nsISearchEngine);
            LOG("nsSearchService::observe: Done installation of " + engine.name
                + ".");
            this._addEngineToStore(engine.wrappedJSObject);
            if (engine.wrappedJSObject._useNow) {
              LOG("nsSearchService::observe: setting current");
              this.currentEngine = aEngine;
            }
            this.batchTask.start();
            break;
          case SEARCH_ENGINE_CHANGED:
          case SEARCH_ENGINE_REMOVED:
            this.batchTask.start();
            break;
        }
        break;

      case QUIT_APPLICATION_TOPIC:
        this._removeObservers();
        if (this._batchTask) {
          // Flush to disk immediately
          this._batchTask.flush();
        }
        engineMetadataService.flush();
        break;

      case "nsPref:changed":
        let currPref = BROWSER_SEARCH_PREF + "selectedEngine";
        let defPref = BROWSER_SEARCH_PREF + "defaultenginename";
        if (aVerb == currPref && !this._changingCurrentEngine) {
          this._setEngineByPref("currentEngine", currPref);
        } else if (aVerb == defPref && !this._changingDefaultEngine) {
          this._setEngineByPref("defaultEngine", defPref);
        }
        break;
    }
  },

  // nsITimerCallback
  notify: function SRCH_SVC_notify(aTimer) {
    LOG("_notify: checking for updates");

    if (!getBoolPref(BROWSER_SEARCH_PREF + "update", true))
      return;

    // Our timer has expired, but unfortunately, we can't get any data from it.
    // Therefore, we need to walk our engine-list, looking for expired engines
    var currentTime = Date.now();
    LOG("currentTime: " + currentTime);
    for each (engine in this._engines) {
      engine = engine.wrappedJSObject;
      if (!engine._hasUpdates)
        continue;

      LOG("checking " + engine.name);

      var expirTime = engineMetadataService.getAttr(engine, "updateexpir");
      LOG("expirTime: " + expirTime + "\nupdateURL: " + engine._updateURL +
          "\niconUpdateURL: " + engine._iconUpdateURL);

      var engineExpired = expirTime <= currentTime;

      if (!expirTime || !engineExpired) {
        LOG("skipping engine");
        continue;
      }

      LOG(engine.name + " has expired");

      engineUpdateService.update(engine);

      // Schedule the next update
      engineUpdateService.scheduleNextUpdate(engine);

    } // end engine iteration
  },

  _addObservers: function SRCH_SVC_addObservers() {
    Services.obs.addObserver(this, SEARCH_ENGINE_TOPIC, false);
    Services.obs.addObserver(this, QUIT_APPLICATION_TOPIC, false);
    Services.prefs.addObserver(BROWSER_SEARCH_PREF + "defaultenginename", this, false);
    Services.prefs.addObserver(BROWSER_SEARCH_PREF + "selectedEngine", this, false);
  },

  _removeObservers: function SRCH_SVC_removeObservers() {
    Services.obs.removeObserver(this, SEARCH_ENGINE_TOPIC);
    Services.obs.removeObserver(this, QUIT_APPLICATION_TOPIC);
    Services.prefs.removeObserver(BROWSER_SEARCH_PREF + "defaultenginename", this);
    Services.prefs.removeObserver(BROWSER_SEARCH_PREF + "selectedEngine", this);
  },

  QueryInterface: function SRCH_SVC_QI(aIID) {
    if (aIID.equals(Ci.nsIBrowserSearchService) ||
        aIID.equals(Ci.nsIObserver)             ||
        aIID.equals(Ci.nsITimerCallback)        ||
        aIID.equals(Ci.nsISupports))
      return this;
    throw Cr.NS_ERROR_NO_INTERFACE;
  }
};

var engineMetadataService = {
  _jsonFile: OS.Path.join(OS.Constants.Path.profileDir, "search-metadata.json"),

  /**
   * Possible values for |_initState|.
   *
   * We have two paths to perform initialization: a default asynchronous
   * path and a fallback synchronous path that can interrupt the async
   * path. For this reason, initialization is actually something of a
   * finite state machine, represented with the following states:
   *
   * @enum
   */
  _InitStates: {
    NOT_STARTED: "NOT_STARTED"
      /**Initialization has not started*/,
    FINISHED_SUCCESS: "FINISHED_SUCCESS"
      /**Setup complete, with a success*/
  },

  /**
   * The latest step completed by initialization. One of |InitStates|
   *
   * @type {engineMetadataService._InitStates}
   */
  _initState: null,

  // A promise fulfilled once initialization is complete
  _initializer: null,

  /**
   * Asynchronous initializer
   *
   * Note: In the current implementation, initialization never fails.
   */
  init: function epsInit() {
    if (!this._initializer) {
      // Launch asynchronous initialization
      let initializer = this._initializer = Promise.defer();
      TaskUtils.spawn((function task_init() {
        LOG("metadata init: starting");
        switch (this._initState) {
          case engineMetadataService._InitStates.NOT_STARTED:
            // 1. Load json file if it exists
            try {
              let contents = yield OS.File.read(this._jsonFile);
              if (this._initState == engineMetadataService._InitStates.FINISHED_SUCCESS) {
                // No need to pursue asynchronous initialization,
                // synchronous fallback was called and has finished.
                return;
              }
              this._store = JSON.parse(new TextDecoder().decode(contents));
            } catch (ex) {
              if (this._initState == engineMetadataService._InitStates.FINISHED_SUCCESS) {
                // No need to pursue asynchronous initialization,
                // synchronous fallback was called and has finished.
                return;
              }
              // Couldn't load json, use an empty store
              LOG("metadata init: could not load JSON file " + ex);
              this._store = {};
            }
            break;

          default:
            throw new Error("metadata init: invalid state " + this._initState);
        }

        this._initState = this._InitStates.FINISHED_SUCCESS;
        LOG("metadata init: complete");
      }).bind(this)).then(
        // 3. Inform any observers
        function onSuccess() {
          initializer.resolve();
        },
        function onError() {
          initializer.reject();
        }
      );
    }
    return TaskUtils.captureErrors(this._initializer.promise);
  },

  /**
   * Synchronous implementation of initializer
   *
   * This initializer is able to pick wherever the async initializer
   * is waiting. The asynchronous initializer is expected to stop
   * if it detects that the synchronous initializer has completed
   * initialization.
   */
  syncInit: function epsSyncInit() {
    LOG("metadata syncInit start");
    if (this._initState == engineMetadataService._InitStates.FINISHED_SUCCESS) {
      return;
    }
    switch (this._initState) {
      case engineMetadataService._InitStates.NOT_STARTED:
        let jsonFile = new FileUtils.File(this._jsonFile);
        // 1. Load json file if it exists
        if (jsonFile.exists()) {
          try {
            let uri = Services.io.newFileURI(jsonFile);
            let stream = Services.io.newChannelFromURI(uri).open();
            this._store = parseJsonFromStream(stream);
          } catch (x) {
            LOG("metadata syncInit: could not load JSON file " + x);
            this._store = {};
          }
        } else {
          LOG("metadata syncInit: using an empty store");
          this._store = {};
        }

        this._initState = this._InitStates.FINISHED_SUCCESS;
        break;

      default:
        throw new Error("metadata syncInit: invalid state " + this._initState);
    }

    // 3. Inform any observers
    if (this._initializer) {
      this._initializer.resolve();
    } else {
      this._initializer = Promise.resolve();
    }
    LOG("metadata syncInit end");
  },

  getAttr: function epsGetAttr(engine, name) {
    let record = this._store[engine._id];
    if (!record) {
      return null;
    }

    // attr names must be lower case
    let aName = name.toLowerCase();
    if (!record[aName])
      return null;
    return record[aName];
  },

  _setAttr: function epsSetAttr(engine, name, value) {
    // attr names must be lower case
    name = name.toLowerCase();
    let db = this._store;
    let record = db[engine._id];
    if (!record) {
      record = db[engine._id] = {};
    }
    if (!record[name] || (record[name] != value)) {
      record[name] = value;
      return true;
    }
    return false;
  },

  /**
   * Set one metadata attribute for an engine.
   *
   * If an actual change has taken place, the attribute is committed
   * automatically (and lazily), using this._commit.
   *
   * @param {nsISearchEngine} engine The engine to update.
   * @param {string} key The name of the attribute. Case-insensitive. In
   * the current implementation, this _must not_ conflict with properties
   * of |Object|.
   * @param {*} value A value to store.
   */
  setAttr: function epsSetAttr(engine, key, value) {
    if (this._setAttr(engine, key, value)) {
      this._commit();
    }
  },

  /**
   * Bulk set metadata attributes for a number of engines.
   *
   * If actual changes have taken place, the store is committed
   * automatically (and lazily), using this._commit.
   *
   * @param {Array.<{engine: nsISearchEngine, key: string, value: *}>} changes
   * The list of changes to effect. See |setAttr| for the documentation of
   * |engine|, |key|, |value|.
   */
  setAttrs: function epsSetAttrs(changes) {
    let self = this;
    let changed = false;
    changes.forEach(function(change) {
      changed |= self._setAttr(change.engine, change.key, change.value);
    });
    if (changed) {
      this._commit();
    }
  },

  /**
   * Flush any waiting write.
   */
  flush: function epsFlush() {
    if (this._lazyWriter) {
      this._lazyWriter.flush();
    }
  },

  /**
   * Commit changes to disk, asynchronously.
   *
   * Calls to this function are actually delayed by LAZY_SERIALIZE_DELAY
   * (= 100ms). If the function is called again before the expiration of
   * the delay, commits are merged and the function is again delayed by
   * the same amount of time.
   *
   * @param aStore is an optional parameter specifying the object to serialize.
   *               If not specified, this._store is used.
   */
  _commit: function epsCommit(aStore) {
    LOG("metadata _commit: start");
    let store = aStore || this._store;
    if (!store) {
      LOG("metadata _commit: nothing to do");
      return;
    }

    if (!this._lazyWriter) {
      LOG("metadata _commit: initializing lazy writer");
      function writeCommit() {
        LOG("metadata writeCommit: start");
        let data = gEncoder.encode(JSON.stringify(store));
        let path = engineMetadataService._jsonFile;
        LOG("metadata writeCommit: path " + path);
        let promise = OS.File.writeAtomic(path, data, { tmpPath: path + ".tmp" });
        promise = promise.then(
          function onSuccess() {
            Services.obs.notifyObservers(null,
              SEARCH_SERVICE_TOPIC,
              SEARCH_SERVICE_METADATA_WRITTEN);
            LOG("metadata writeCommit: done");
          }
        );
        TaskUtils.captureErrors(promise);
      }
      this._lazyWriter = new DeferredTask(writeCommit, LAZY_SERIALIZE_DELAY);
    }
    LOG("metadata _commit: (re)setting timer");
    this._lazyWriter.start();
  },
  _lazyWriter: null
};

engineMetadataService._initState = engineMetadataService._InitStates.NOT_STARTED;

const SEARCH_UPDATE_LOG_PREFIX = "*** Search update: ";

/**
 * Outputs aText to the JavaScript console as well as to stdout, if the search
 * logging pref (browser.search.update.log) is set to true.
 */
function ULOG(aText) {
  if (getBoolPref(BROWSER_SEARCH_PREF + "update.log", false)) {
    dump(SEARCH_UPDATE_LOG_PREFIX + aText + "\n");
    Services.console.logStringMessage(aText);
  }
}

var engineUpdateService = {
  scheduleNextUpdate: function eus_scheduleNextUpdate(aEngine) {
    var interval = aEngine._updateInterval || SEARCH_DEFAULT_UPDATE_INTERVAL;
    var milliseconds = interval * 86400000; // |interval| is in days
    engineMetadataService.setAttr(aEngine, "updateexpir",
                                  Date.now() + milliseconds);
  },

  update: function eus_Update(aEngine) {
    let engine = aEngine.wrappedJSObject;
    ULOG("update called for " + aEngine._name);
    if (!getBoolPref(BROWSER_SEARCH_PREF + "update", true) || !engine._hasUpdates)
      return;

    // We use the cache to store updated app engines, so refuse to update if the
    // cache is disabled.
    if (engine._readOnly &&
        !getBoolPref(BROWSER_SEARCH_PREF + "cache.enabled", true))
      return;

    let testEngine = null;
    let updateURL = engine._getURLOfType(URLTYPE_OPENSEARCH);
    let updateURI = (updateURL && updateURL._hasRelation("self")) ? 
                     updateURL.getSubmission("", engine).uri :
                     makeURI(engine._updateURL);
    if (updateURI) {
      if (engine._isDefault && !updateURI.schemeIs("https")) {
        ULOG("Invalid scheme for default engine update");
        return;
      }

      let dataType = engineMetadataService.getAttr(engine, "updatedatatype");
      if (!dataType) {
        ULOG("No loadtype to update engine!");
        return;
      }

      ULOG("updating " + engine.name + " from " + updateURI.spec);
      testEngine = new Engine(updateURI, dataType, false);
      testEngine._engineToUpdate = engine;
      testEngine._initFromURIAndLoad();
    } else
      ULOG("invalid updateURI");

    if (engine._iconUpdateURL) {
      // If we're updating the engine too, use the new engine object,
      // otherwise use the existing engine object.
      (testEngine || engine)._setIcon(engine._iconUpdateURL, true);
    }
  }
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([SearchService]);

#include ../../../toolkit/modules/debug.js
