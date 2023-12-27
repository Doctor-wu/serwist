/*
  Copyright 2018 Google LLC

  Use of this source code is governed by an MIT-style
  license that can be found in the LICENSE file or at
  https://opensource.org/licenses/MIT.
*/
import type { WebpackInjectManifestOptions } from "@serwist/build";
import { escapeRegExp, replaceAndUpdateSourceMap, validateWebpackInjectManifestOptions } from "@serwist/build";
import stringify from "fast-json-stable-stringify";
import prettyBytes from "pretty-bytes";
import upath from "upath";
import type { Compilation } from "webpack";
import webpack from "webpack";

import { getManifestEntriesFromCompilation } from "./lib/get-manifest-entries-from-compilation.js";
import { getSourcemapAssetName } from "./lib/get-sourcemap-asset-name.js";
import { relativeToOutputPath } from "./lib/relative-to-output-path.js";

// Used to keep track of swDest files written by *any* instance of this plugin.
// See https://github.com/GoogleChrome/workbox/issues/2181
const _generatedAssetNames = new Set<string>();

/**
 * This class supports compiling a service worker file provided via `swSrc`,
 * and injecting into that service worker a list of URLs and revision
 * information for precaching based on the webpack asset pipeline.
 *
 * Use an instance of `InjectManifest` in the
 * [`plugins` array](https://webpack.js.org/concepts/plugins/#usage) of a
 * webpack config.
 *
 * In addition to injecting the manifest, this plugin will perform a compilation
 * of the `swSrc` file, using the options from the main webpack configuration.
 *
 * ```
 * // The following lists some common options; see the rest of the documentation
 * // for the full set of options and defaults.
 * new InjectManifest({
 *   exclude: [/.../, '...'],
 *   maximumFileSizeToCacheInBytes: ...,
 *   swSrc: '...',
 * });
 * ```
 */
class InjectManifest {
  protected config: WebpackInjectManifestOptions;
  private alreadyCalled: boolean;

  /**
   * Creates an instance of InjectManifest.
   */
  constructor(config: WebpackInjectManifestOptions) {
    this.config = config;
    this.alreadyCalled = false;
  }

  /**
   * @param compiler default compiler object passed from webpack
   *
   * @private
   */
  propagateWebpackConfig(compiler: webpack.Compiler): void {
    const parsedSwSrc = upath.parse(this.config.swSrc);
    // Because this.config is listed last, properties that are already set
    // there take precedence over derived properties from the compiler.
    this.config = Object.assign(
      {
        mode: compiler.options.mode,
        // Use swSrc with a hardcoded .js extension, in case swSrc is a .ts file.
        swDest: parsedSwSrc.name + ".js",
      },
      this.config
    );
  }

  /**
   * `getManifestEntriesFromCompilation` with a few additional checks.
   *
   * @private
   */
  async getManifestEntries(compilation: webpack.Compilation, config: WebpackInjectManifestOptions) {
    if (config.disablePrecacheManifest) {
      return {
        size: 0,
        sortedEntries: undefined,
        manifestString: "undefined",
      };
    }

    // See https://github.com/GoogleChrome/workbox/issues/1790
    if (this.alreadyCalled) {
      const warningMessage =
        `${this.constructor.name} has been called ` +
        `multiple times, perhaps due to running webpack in --watch mode. The ` +
        `precache manifest generated after the first call may be inaccurate! ` +
        `Please see https://github.com/GoogleChrome/workbox/issues/1790 for ` +
        `more information.`;

      if (!compilation.warnings.some((warning) => warning instanceof Error && warning.message === warningMessage)) {
        compilation.warnings.push(new Error(warningMessage) as webpack.WebpackError);
      }
    } else {
      this.alreadyCalled = true;
    }

    // Ensure that we don't precache any of the assets generated by *any*
    // instance of this plugin.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    config.exclude!.push(({ asset }) => _generatedAssetNames.has(asset.name));

    const { size, sortedEntries } = await getManifestEntriesFromCompilation(compilation, config);

    let manifestString = stringify(sortedEntries);
    if (
      this.config.compileSrc &&
      // See https://github.com/GoogleChrome/workbox/issues/2729
      !(compilation.options?.devtool === "eval-cheap-source-map" && compilation.options.optimization?.minimize)
    ) {
      // See https://github.com/GoogleChrome/workbox/issues/2263
      manifestString = manifestString.replace(/"/g, `'`);
    }

    return { size, sortedEntries, manifestString };
  }

  /**
   * @param compiler default compiler object passed from webpack
   *
   * @private
   */
  apply(compiler: webpack.Compiler): void {
    this.propagateWebpackConfig(compiler);

    compiler.hooks.make.tapPromise(this.constructor.name, (compilation) =>
      this.handleMake(compilation, compiler).catch((error: webpack.WebpackError) => {
        compilation.errors.push(error);
      })
    );

    const { PROCESS_ASSETS_STAGE_OPTIMIZE_TRANSFER } = webpack.Compilation;
    // Specifically hook into thisCompilation, as per
    // https://github.com/webpack/webpack/issues/11425#issuecomment-690547848
    compiler.hooks.thisCompilation.tap(this.constructor.name, (compilation) => {
      compilation.hooks.processAssets.tapPromise(
        {
          name: this.constructor.name,
          // TODO(jeffposnick): This may need to change eventually.
          // See https://github.com/webpack/webpack/issues/11822#issuecomment-726184972
          stage: PROCESS_ASSETS_STAGE_OPTIMIZE_TRANSFER - 10,
        },
        () =>
          this.addAssets(compilation).catch((error: webpack.WebpackError) => {
            compilation.errors.push(error);
          })
      );
    });
  }

  /**
   * @param compilation The webpack compilation.
   * @param parentCompiler The webpack parent compiler.
   *
   * @private
   */
  async performChildCompilation(compilation: webpack.Compilation, parentCompiler: webpack.Compiler): Promise<void> {
    const outputOptions: Parameters<Compilation["createChildCompiler"]>["1"] = {
      filename: this.config.swDest,
    };

    const childCompiler = compilation.createChildCompiler(this.constructor.name, outputOptions, []);

    childCompiler.context = parentCompiler.context;
    childCompiler.inputFileSystem = parentCompiler.inputFileSystem;
    childCompiler.outputFileSystem = parentCompiler.outputFileSystem;

    if (Array.isArray(this.config.webpackCompilationPlugins)) {
      for (const plugin of this.config.webpackCompilationPlugins) {
        plugin.apply(childCompiler);
      }
    }

    new webpack.EntryPlugin(parentCompiler.context, this.config.swSrc, this.constructor.name).apply(childCompiler);

    await new Promise<void>((resolve, reject) => {
      childCompiler.runAsChild((error, _entries, childCompilation) => {
        if (error) {
          reject(error);
        } else {
          compilation.warnings = compilation.warnings.concat(childCompilation?.warnings ?? []);
          compilation.errors = compilation.errors.concat(childCompilation?.errors ?? []);

          resolve();
        }
      });
    });
  }

  /**
   * @param compilation The webpack compilation.
   * @param parentCompiler The webpack parent compiler.
   *
   * @private
   */
  addSrcToAssets(compilation: webpack.Compilation, parentCompiler: webpack.Compiler): void {
    // eslint-disable-next-line
    const source = (parentCompiler.inputFileSystem as any).readFileSync(this.config.swSrc);
    compilation.emitAsset(this.config.swDest!, new webpack.sources.RawSource(source));
  }

  /**
   * @param compilation The webpack compilation.
   * @param parentCompiler The webpack parent compiler.
   *
   * @private
   */
  async handleMake(compilation: webpack.Compilation, parentCompiler: webpack.Compiler): Promise<void> {
    try {
      this.config = validateWebpackInjectManifestOptions(this.config);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Please check your ${this.constructor.name} plugin ` + `configuration:\n${error.message}`);
      }
    }

    this.config.swDest = relativeToOutputPath(compilation, this.config.swDest!);
    _generatedAssetNames.add(this.config.swDest);

    if (this.config.compileSrc) {
      await this.performChildCompilation(compilation, parentCompiler);
    } else {
      this.addSrcToAssets(compilation, parentCompiler);
      // This used to be a fatal error, but just warn at runtime because we
      // can't validate it easily.
      if (Array.isArray(this.config.webpackCompilationPlugins) && this.config.webpackCompilationPlugins.length > 0) {
        compilation.warnings.push(
          new Error("compileSrc is false, so the " + "webpackCompilationPlugins option will be ignored.") as webpack.WebpackError
        );
      }
    }
  }

  /**
   * @param compilation The webpack compilation.
   *
   * @private
   */
  async addAssets(compilation: webpack.Compilation): Promise<void> {
    const config = Object.assign({}, this.config);

    const { size, sortedEntries, manifestString } = await this.getManifestEntries(compilation, config);

    // See https://webpack.js.org/contribute/plugin-patterns/#monitoring-the-watch-graph
    const absoluteSwSrc = upath.resolve(config.swSrc);
    compilation.fileDependencies.add(absoluteSwSrc);

    const swAsset = compilation.getAsset(config.swDest!);
    const swAssetString = swAsset!.source.source().toString();

    const globalRegexp = new RegExp(escapeRegExp(config.injectionPoint!), "g");
    const injectionResults = swAssetString.match(globalRegexp);

    if (!injectionResults) {
      throw new Error(`Can't find ${config.injectionPoint} in your SW source.`);
    }
    if (injectionResults.length !== 1) {
      throw new Error(
        `Multiple instances of ${config.injectionPoint} were ` +
          "found in your SW source. Include it only once. For more info, see " +
          "https://github.com/GoogleChrome/workbox/issues/2681"
      );
    }

    const sourcemapAssetName = getSourcemapAssetName(compilation, swAssetString, config.swDest!);

    if (sourcemapAssetName) {
      _generatedAssetNames.add(sourcemapAssetName);
      const sourcemapAsset = compilation.getAsset(sourcemapAssetName);
      const { source, map } = await replaceAndUpdateSourceMap({
        jsFilename: config.swDest!,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        originalMap: JSON.parse(sourcemapAsset!.source.source().toString()),
        originalSource: swAssetString,
        replaceString: manifestString,
        searchString: config.injectionPoint!,
      });

      compilation.updateAsset(sourcemapAssetName, new webpack.sources.RawSource(map));
      compilation.updateAsset(config.swDest!, new webpack.sources.RawSource(source));
    } else {
      // If there's no sourcemap associated with swDest, a simple string
      // replacement will suffice.
      compilation.updateAsset(config.swDest!, new webpack.sources.RawSource(swAssetString.replace(config.injectionPoint!, manifestString)));
    }

    if (compilation.getLogger) {
      const logger = compilation.getLogger(this.constructor.name);
      logger.info(`The service worker at ${config.swDest ?? ""} will precache ${sortedEntries?.length ?? 0} URLs, totaling ${prettyBytes(size)}.`);
    }
  }
}

export { InjectManifest };
