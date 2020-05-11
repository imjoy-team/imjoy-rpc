// Karma configuration
// Generated on Sun Mar 08 2020 02:01:17 GMT+0100 (GMT+01:00)
var webpackConfig = require('./webpack.config.js');

module.exports = function (config) {
    config.set({

        // base path that will be used to resolve all patterns (eg. files, exclude)
        basePath: '',


        // frameworks to use
        // available frameworks: https://npmjs.org/browse/keyword/karma-adapter
        frameworks: ['mocha'],


        // list of files / patterns to load in the browser
        files: [
            // only specify one entry point
            // and require all tests in there
            'tests/*_test.js',
            { pattern: 'src/jailed/*', watched: false, included: false, served: true, nocache: false },
            { pattern: 'src/*.js', watched: false, included: false, served: true, nocache: false },
        ],

        proxies: {
            "/static/jailed/": "/base/src/jailed/",
            "/plugin-service-worker.js": "/base/src/plugin-service-worker.js"
        },


        // list of files / patterns to exclude
        exclude: [
        ],


        // preprocess matching files before serving them to the browser
        // available preprocessors: https://npmjs.org/browse/keyword/karma-preprocessor
        preprocessors: {
        // add webpack as preprocessor
        'tests/*_test.js': ['webpack']
        },

        webpack: webpackConfig(null, {'filename': 'imjoy-rpc.js'}),

        webpackMiddleware: {
        // webpack-dev-middleware configuration
        // i. e.
        stats: 'errors-only',
        },


        // test results reporter to use
        // possible values: 'dots', 'progress'
        // available reporters: https://npmjs.org/browse/keyword/karma-reporter
        reporters: ["spec"],
        specReporter: {
            maxLogLines: 5, // limit number of lines logged per test
            suppressErrorSummary: true, // do not print error summary
            suppressFailed: false, // do not print information about failed tests
            suppressPassed: false, // do not print information about passed tests
            suppressSkipped: true, // do not print information about skipped tests
            showSpecTiming: false // print the time elapsed for each spec
        },


        // web server port
        port: 9876,


        // enable / disable colors in the output (reporters and logs)
        colors: true,


        // level of logging
        // possible values: config.LOG_DISABLE || config.LOG_ERROR || config.LOG_WARN || config.LOG_INFO || config.LOG_DEBUG
        logLevel: config.LOG_INFO,


        // enable / disable watching file and executing tests whenever any file changes
        autoWatch: true,


        // start these browsers
        // available browser launchers: https://npmjs.org/browse/keyword/karma-launcher
        browsers: ['ChromeHeadlessNoSandbox', 'FirefoxHeadless'],

        customLaunchers: {
            ChromeHeadlessNoSandbox: {
                base: 'ChromeHeadless',
                flags: ["--no-sandbox"]
            }
        },

        // Continuous Integration mode
        // if true, Karma captures browsers, runs the tests and exits
        singleRun: false,

        // Concurrency level
        // how many browser should be started simultaneous
        concurrency: Infinity,
        captureTimeout: 12000,
        browserDisconnectTolerance: 2,
        browserDisconnectTimeout : 10000,
        browserNoActivityTimeout : 10000,
    })
}