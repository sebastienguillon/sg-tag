// @ts-check
import eslint from '@eslint/js';
import angular from 'angular-eslint';
import prettier from 'eslint-config-prettier/flat';
import { defineConfig, globalIgnores } from 'eslint/config';
import { builtinModules } from 'node:module';
import tseslint from 'typescript-eslint';

/** Bare Node built-in specifiers (`fs`, `path`…); `node:`-only modules are covered by the `node:*` pattern. */
const nodeBuiltins = builtinModules.filter((name) => !name.startsWith('_') && !name.includes(':'));

/**
 * Enforces the process boundaries: each layer only reaches the others through `@shared/*` contracts.
 * @param {{ node: boolean; electron: 'allow' | 'types' | 'deny'; forbiddenLayers: string[] }} layer
 * @returns {import('eslint').Linter.RuleEntry}
 */
function layerImports({ node, electron, forbiddenLayers }) {
  return [
    'error',
    {
      paths: [
        ...(node
          ? nodeBuiltins.map((name) => ({ name, message: `Import "node:${name}" instead.` }))
          : []),
        ...(electron === 'allow'
          ? []
          : [
              {
                name: 'electron',
                message: 'Electron APIs are not available in this layer.',
                allowTypeImports: electron === 'types',
              },
            ]),
      ],
      patterns: [
        ...(node
          ? []
          : [
              {
                group: ['node:*', ...nodeBuiltins],
                message: 'Node built-ins are not available in this layer.',
              },
            ]),
        ...forbiddenLayers.map((layer) => ({
          group: [`**/${layer}`, `**/${layer}/**`],
          message: `Do not import from the ${layer} layer; share code through src/shared (@shared/*).`,
        })),
      ],
    },
  ];
}

export default defineConfig(
  globalIgnores(['dist/', 'release/', 'coverage/', '.angular/', 'out-tsc/']),

  {
    name: 'sg-tag/typescript',
    files: ['**/*.{ts,js}'],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      prettier,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
    rules: {
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      'no-else-return': ['error', { allowElseIf: false }],
      'no-implicit-coercion': 'error',
      'no-lonely-if': 'error',
      'no-nested-ternary': 'error',
      'no-param-reassign': 'error',
      'no-return-assign': ['error', 'always'],
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-unneeded-ternary': 'error',
      'no-useless-concat': 'error',
      'no-useless-rename': 'error',
      'object-shorthand': ['error', 'always'],
      'prefer-arrow-callback': 'error',
      'prefer-object-spread': 'error',
      'prefer-template': 'error',
      radix: 'error',

      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/default-param-last': 'error',
      '@typescript-eslint/explicit-member-accessibility': ['error', { accessibility: 'no-public' }],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/method-signature-style': ['error', 'property'],
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-loop-func': 'error',
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-useless-empty-export': 'error',
      // Conflicts with no-non-null-assertion: a checked `as T` is preferred over `!`.
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/require-array-sort-compare': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        { allowString: false, allowNumber: false, allowNullableObject: true },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true, requireDefaultForNonUnion: true },
      ],
    },
  },
  {
    name: 'sg-tag/javascript',
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  {
    name: 'sg-tag/renderer',
    files: ['src/renderer/**/*.ts'],
    extends: [angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'app', style: 'kebab-case' },
      ],
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'app', style: 'camelCase' },
      ],
      '@angular-eslint/prefer-on-push-component-change-detection': [
        'error',
        { allowExplicitOnPush: false },
      ],
      '@angular-eslint/component-max-inline-declarations': 'error',
      '@angular-eslint/computed-must-return': 'error',
      '@angular-eslint/consistent-component-styles': ['error', 'string'],
      '@angular-eslint/inject-at-top': 'error',
      '@angular-eslint/no-async-lifecycle-method': 'error',
      '@angular-eslint/no-attribute-decorator': 'error',
      '@angular-eslint/no-developer-preview': 'error',
      '@angular-eslint/no-experimental': 'error',
      '@angular-eslint/no-implicit-take-until-destroyed': 'error',
      '@angular-eslint/no-lifecycle-call': 'error',
      '@angular-eslint/no-pipe-impure': 'error',
      '@angular-eslint/no-uncalled-signals': 'error',
      '@angular-eslint/prefer-host-metadata-property': 'error',
      '@angular-eslint/prefer-inject': 'error',
      '@angular-eslint/prefer-output-emitter-ref': 'error',
      '@angular-eslint/prefer-output-readonly': 'error',
      '@angular-eslint/prefer-signal-model': 'error',
      '@angular-eslint/prefer-signals': 'error',
      '@angular-eslint/reactive-context-must-read-signal': 'error',
      '@angular-eslint/relative-url-prefix': 'error',
      '@angular-eslint/require-lifecycle-on-prototype': 'error',
      '@angular-eslint/sort-lifecycle-methods': 'error',
      '@angular-eslint/use-component-view-encapsulation': 'error',
      '@angular-eslint/use-lifecycle-interface': 'error',
      'no-restricted-imports': layerImports({
        node: false,
        electron: 'deny',
        forbiddenLayers: ['main', 'worker', 'preload', 'shared'],
      }),
    },
  },
  {
    name: 'sg-tag/renderer-templates',
    files: ['src/renderer/**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
    rules: {
      '@angular-eslint/template/attributes-order': 'error',
      '@angular-eslint/template/button-has-type': 'error',
      '@angular-eslint/template/eqeqeq': 'error',
      '@angular-eslint/template/no-any': 'error',
      '@angular-eslint/template/no-duplicate-attributes': 'error',
      '@angular-eslint/template/no-inline-styles': ['error', { allowBindToStyle: true }],
      '@angular-eslint/template/no-interpolation-in-attributes': 'error',
      '@angular-eslint/template/prefer-at-else': 'error',
      '@angular-eslint/template/prefer-at-empty': 'error',
      '@angular-eslint/template/prefer-class-binding': 'error',
      '@angular-eslint/template/prefer-contextual-for-variables': 'error',
      '@angular-eslint/template/prefer-control-flow': 'error',
      '@angular-eslint/template/prefer-self-closing-tags': 'error',
      '@angular-eslint/template/prefer-static-string-properties': 'error',
      '@angular-eslint/template/prefer-style-binding': 'error',
      '@angular-eslint/template/prefer-template-literal': 'error',
    },
  },

  {
    name: 'sg-tag/shared',
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': layerImports({
        node: false,
        electron: 'deny',
        forbiddenLayers: ['main', 'worker', 'preload', 'renderer'],
      }),
    },
  },
  {
    name: 'sg-tag/main',
    files: ['src/main/**/*.ts'],
    rules: {
      'no-restricted-imports': layerImports({
        node: true,
        electron: 'allow',
        forbiddenLayers: ['worker', 'preload', 'renderer'],
      }),
    },
  },
  {
    name: 'sg-tag/worker',
    files: ['src/worker/**/*.ts'],
    rules: {
      'no-restricted-imports': layerImports({
        node: true,
        electron: 'types',
        forbiddenLayers: ['main', 'preload', 'renderer'],
      }),
    },
  },
  {
    name: 'sg-tag/preload',
    files: ['src/preload/**/*.ts'],
    rules: {
      'no-restricted-imports': layerImports({
        node: false,
        electron: 'allow',
        forbiddenLayers: ['main', 'worker', 'renderer'],
      }),
    },
  },
  {
    name: 'sg-tag/scripts',
    files: ['scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
      'no-restricted-imports': layerImports({ node: true, electron: 'allow', forbiddenLayers: [] }),
    },
  },
  {
    name: 'sg-tag/logger',
    files: ['src/shared/log.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    name: 'sg-tag/tests',
    files: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
