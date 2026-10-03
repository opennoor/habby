import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
export default {
    context: root, target: 'node', mode: 'production', entry: './src/index.ts', devtool: 'source-map',
    output: { path: path.join(root, 'dist'), filename: 'index.js', libraryTarget: 'commonjs2' },
    resolve: { extensions: ['.ts', '.js', '.json'], extensionAlias: { '.js': ['.ts', '.js'] } },
    module: { rules: [{ test: /\.ts$/, use: { loader: 'ts-loader', options: { configFile: path.join(root, 'tsconfig.json') } }, exclude: /node_modules/ }] },
    externals: ['tabby-core', 'tabby-terminal', 'tabby-settings', 'tabby-ssh', 'rxjs', 'rxjs/operators', /^@angular\/.*/, /^tabby-.*/, 'electron', '@electron/remote', 'bufferutil', 'utf-8-validate'],
    optimization: { minimize: false },
};
