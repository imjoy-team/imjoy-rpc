const path = require('path')
const {
  InjectManifest
} = require('workbox-webpack-plugin');
const BundleAnalyzerPlugin = require('webpack-bundle-analyzer')
  .BundleAnalyzerPlugin

module.exports = {
  mode: 'development',
  entry: {
      'imjoyRPC': path.resolve(__dirname, 'src', 'main.js'),
      'imjoyRPCSocketIO': path.resolve(__dirname, 'src', 'socketIOMain.js'),
  },
  output: {
      path: path.resolve(__dirname, 'dist'),
      filename(pathData){
        let name = pathData.chunk.name === 'imjoyRPC' ? 'imjoy-rpc' : 'imjoy-rpc-socketio';
        return process.env.NODE_ENV === 'production'? name + '.min.js': name + '.js';
      },
      library: '[name]',
      libraryTarget: 'umd',
      umdNamedDefine: true
  },
  devtool: '#source-maps',
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
  plugins: (process.env.NODE_ENV === 'production' ? [
    new InjectManifest({
      swDest: 'plugin-service-worker.js',
      swSrc: path.join(__dirname, 'src/plugin-service-worker.js'),
      exclude: [new RegExp('^[.].*'), new RegExp('.*[.]map$')]
    }),
    new BundleAnalyzerPlugin({
      analyzerMode: 'static',
      openAnalyzer: false,
      reportFilename: path.join(__dirname, 'report.html'),
    }),
  ] : []),
  module: {
    rules: [{
        test: /\.webworker\.js$/,
        use: [{
          loader: 'worker-loader',
          options: {
            inline: true,
            name: '[name].js',
            fallback: false
          }
        }, ],
      },
      {
        test: /\.js$/,
        exclude: [/node_modules/, /\.webworker\.js$/],
        use: [{
            loader: 'babel-loader',
            options: {
              presets: [
                [
                  '@babel/preset-env',
                  {
                    targets: {
                      browsers: ['last 2 Chrome versions']
                    },
                    useBuiltIns: 'entry',
                    corejs: "3.0.0",
                    modules: false,
                  },
                ],
              ],
              plugins: ['@babel/plugin-syntax-dynamic-import'],
              cacheDirectory: true,
            },
          },
          "eslint-loader"
        ],
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
}
