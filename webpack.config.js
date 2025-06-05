const path = require('path');

module.exports = {
  entry: './index.js',
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'public'),
  },
  mode: 'development', // Or 'production'
  target: 'web',
  resolve: {
    fallback: {
      "util": require.resolve("util/")
    }
  }
};