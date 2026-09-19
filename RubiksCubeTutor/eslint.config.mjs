export default [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', self: 'readonly', localStorage: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        console: 'readonly', module: 'writable', require: 'readonly', location: 'readonly',
        Event: 'readonly', SpeechSynthesisUtterance: 'readonly', speechSynthesis: 'readonly',
        Promise: 'readonly', Set: 'readonly', Map: 'readonly', process: 'readonly', __dirname: 'readonly',
        getComputedStyle: 'readonly', PointerEvent: 'readonly',
        // the app's own global, reached from inside page.evaluate() in the browser tests
        RC: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      // off: the axis-rotation triples in cube.js spell out the unchanged component
      // on purpose, e.g. [x, y, z] = [-z, y, x], which reads far better than a partial swap.
      'no-self-assign': 'off',
      'no-constant-condition': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-fallthrough': 'error',
    },
  },
];
