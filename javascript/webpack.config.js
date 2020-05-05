const path = require('path')
const CopyPlugin = require('copy-webpack-plugin');
// const WriteFilePlugin = require('write-file-webpack-plugin');
const BundleAnalyzerPlugin = require('webpack-bundle-analyzer')
  .BundleAnalyzerPlugin

const config =  (env, argv) => ({
  mode: 'development',
  entry: {
    index: './src/main.js',
  },
  output: {
    filename: argv.filename || 'imjoy-rpc.js',
    path: path.resolve(__dirname, 'dist'),
    library: 'imjoyRPC',
    libraryTarget: argv.libraryTarget ? argv.libraryTarget : 'umd',
    umdNamedDefine: true,
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
    new CopyPlugin([
      { from: path.resolve(__dirname, 'src', 'jupyter-connection.js'), to: path.resolve(__dirname, 'dist', 'jupyter-connection.js')},
      { from: path.resolve(__dirname, 'src', 'base_frame.html'), to: path.resolve(__dirname, 'dist', 'base_frame.html')},
    ]),
    new BundleAnalyzerPlugin({
      analyzerMode: 'static',
      openAnalyzer: false,
      reportFilename: path.join(__dirname, 'report.html'),
    }),
  ],
  module: {
    rules: [
      {
        test: /\.webworker\.js$/,
        use: [
          { loader: 'worker-loader',  options: { inline: true, name: (argv.filename).split('.').slice(0, -1).join('-')+'-webworker.js', fallback: false}},
        ],
      },
      {
        test: /\.js$/,
        exclude: [/node_modules/,/\.webworker\.js$/],
        use: [{
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
        "eslint-loader"
      ],},
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
})

module.exports = config
