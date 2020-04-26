const path = require('path')
const CopyPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin')
// const WriteFilePlugin = require('write-file-webpack-plugin');
const BundleAnalyzerPlugin = require('webpack-bundle-analyzer')
  .BundleAnalyzerPlugin

const config =  (env, argv) => ({
  mode: 'development',
  entry: {
    index: './src/imjoyRPC.js',
  },
  output: {
    filename: argv.filename || 'imjoy-rpc.js',
    path: path.resolve(__dirname, 'dist'),
    library: 'imjoyRPC',
    libraryTarget: argv.libraryTarget ? argv.libraryTarget : 'umd'
  },
  devtool: 'cheap-module-eval-source-map',
  devServer: {
    contentBase: path.resolve(__dirname, 'dist'),
    publicPath: '/',
    port: 9090,
    hot: true,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "X-Requested-With, content-type, Authorization"
    }
  },
  plugins: [
    new HtmlWebpackPlugin(
      {
        filename: 'base_frame.html',
        template: path.resolve(__dirname, 'src', 'base_frame.html'),
        inject: false
      }
    ),
    new BundleAnalyzerPlugin({
      analyzerMode: 'static',
      openAnalyzer: false,
    }),
    // new WriteFilePlugin(),
  ],
  module: {
    rules: [
      {
        test: /WebWorker\.js$/,
        use: [
          { loader: 'worker-loader',  options: { inline: true, name: (argv.filename).split('.').slice(0, -1).join('-')+'-webworker.js', fallback: true}},
        ],
      },
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [
              [
                '@babel/preset-env',
                {
                  targets: { browsers: ['last 2 Chrome versions'] },
                  useBuiltIns: 'entry',
                  modules: false,
                },
              ],
            ],
            plugins: ['@babel/plugin-syntax-dynamic-import'],
            cacheDirectory: true,
          },
        },
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
})

module.exports = config
