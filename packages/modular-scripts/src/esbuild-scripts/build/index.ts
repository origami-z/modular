import * as esbuild from 'esbuild';
import chalk from 'chalk';
import fs from 'fs-extra';
import * as minimize from 'html-minifier-terser';
import * as path from 'path';
import getClientEnvironment from '../config/getClientEnvironment';

import type { Paths } from '../../utils/createPaths';
import * as logger from '../../utils/logger';
import { formatError } from '../utils/formatError';

import { createIndex } from '../api';
import createEsbuildConfig from '../config/createEsbuildConfig';
import getModularRoot from '../../utils/getModularRoot';
import sanitizeMetafile from '../utils/sanitizeMetafile';
import { createRewriteDependenciesPlugin } from '../plugins/rewriteDependenciesPlugin';
import type { Dependency } from '@schemastore/package';
import createEsbuildBrowserslistTarget from '../../utils/createEsbuildBrowserslistTarget';

export default async function build(
  target: string,
  paths: Paths,
  externalDependencies: Dependency,
  externalResolutions: Dependency,
  type: 'app' | 'esm-view',
) {
  const modularRoot = getModularRoot();
  const isApp = type === 'app';

  const env = getClientEnvironment(paths.publicUrlOrPath.slice(0, -1));

  let result: esbuild.Metafile;

  const browserTarget = createEsbuildBrowserslistTarget(paths.appPath);

  try {
    const buildResult = await esbuild.build(
      createEsbuildConfig(paths, {
        entryNames: 'static/js/[name]-[hash]',
        chunkNames: 'static/js/[name]-[hash]',
        assetNames: 'static/media/[name]-[hash]',
        target: browserTarget,
        plugins: isApp
          ? undefined
          : [
              createRewriteDependenciesPlugin(
                externalDependencies,
                externalResolutions,
                browserTarget,
              ),
            ],
      }),
    );

    result = sanitizeMetafile(paths, buildResult.metafile as esbuild.Metafile);
  } catch (e) {
    const result = e as esbuild.BuildFailure;
    logger.log(chalk.red('Failed to compile.\n'));
    const logs = result.errors.map(async (m) => {
      logger.log(await formatError(m, paths.modularRoot));
    });

    await Promise.all(logs);

    throw new Error(`Failed to build ${target}`);
  }

  // move CSS files to their real location on disk...
  for (const outputFileName of Object.keys(result.outputs)) {
    if (['.css', '.css.map'].some((ext) => outputFileName.endsWith(ext))) {
      const cssFileToMove = outputFileName.replace('/css/', '/js/');
      logger.debug(`Moving css ${cssFileToMove} => ${outputFileName}`);
      await fs.move(
        path.join(modularRoot, cssFileToMove),
        path.join(modularRoot, outputFileName),
      );
    }
  }

  if (isApp) {
    const html = await createIndex({
      paths,
      metafile: result,
      replacements: env.raw,
      includeRuntime: false,
    });

    const minifiedCode = await minimize.minify(html, {
      html5: true,
      collapseBooleanAttributes: true,
      collapseWhitespace: true,
      collapseInlineTagWhitespace: true,
      decodeEntities: true,
      minifyCSS: true,
      minifyJS: true,
      removeAttributeQuotes: false,
      removeComments: true,
      removeTagWhitespace: true,
    });

    await fs.writeFile(path.join(paths.appBuild, 'index.html'), minifiedCode);
  }

  return result;
}
