/*
  Copyright 2021 Google LLC

  Use of this source code is governed by an MIT-style
  license that can be found in the LICENSE file or at
  https://opensource.org/licenses/MIT.
*/

import assert from "assert";

import type { FileDetails, GetManifestOptions, GetManifestResult } from "../types.js";
import { errors } from "./errors.js";
import { getCompositeDetails } from "./get-composite-details.js";
import { getFileDetails } from "./get-file-details.js";
import { getStringDetails } from "./get-string-details.js";
import { transformManifest } from "./transform-manifest.js";

export async function getFileManifestEntries({
  additionalPrecacheEntries,
  dontCacheBustURLsMatching,
  globDirectory,
  globFollow,
  globIgnores,
  globPatterns = [],
  globStrict,
  manifestTransforms,
  maximumFileSizeToCacheInBytes,
  modifyURLPrefix,
  templatedURLs,
  disablePrecacheManifest,
}: GetManifestOptions): Promise<GetManifestResult> {
  const warnings: Array<string> = [];
  const allFileDetails = new Map<string, FileDetails>();

  try {
    for (const globPattern of globPatterns) {
      const { globbedFileDetails, warning } = getFileDetails({
        globDirectory,
        globFollow,
        globIgnores,
        globPattern,
        globStrict,
      });

      if (warning) {
        warnings.push(warning);
      }

      for (const details of globbedFileDetails) {
        if (details && !allFileDetails.has(details.file)) {
          allFileDetails.set(details.file, details);
        }
      }
    }
  } catch (error) {
    // If there's an exception thrown while globbing, then report
    // it back as a warning, and don't consider it fatal.
    if (error instanceof Error && error.message) {
      warnings.push(error.message);
    }
  }

  if (templatedURLs) {
    for (const url of Object.keys(templatedURLs)) {
      assert(!allFileDetails.has(url), errors["templated-url-matches-glob"]);

      const dependencies = templatedURLs[url];
      if (Array.isArray(dependencies)) {
        const details = dependencies.reduce<Array<FileDetails>>((previous, globPattern) => {
          try {
            const { globbedFileDetails, warning } = getFileDetails({
              globDirectory,
              globFollow,
              globIgnores,
              globPattern,
              globStrict,
            });

            if (warning) {
              warnings.push(warning);
            }

            return previous.concat(globbedFileDetails);
          } catch (error) {
            const debugObj: { [key: string]: Array<string> } = {};
            debugObj[url] = dependencies;
            throw new Error(
              `${errors["bad-template-urls-asset"]} ` +
                `'${globPattern}' from '${JSON.stringify(debugObj)}':\n` +
                `${error instanceof Error ? error.toString() : ""}`
            );
          }
        }, []);
        if (details.length === 0) {
          throw new Error(`${errors["bad-template-urls-asset"]} The glob ` + `pattern '${dependencies.toString()}' did not match anything.`);
        }
        allFileDetails.set(url, getCompositeDetails(url, details));
      } else if (typeof dependencies === "string") {
        allFileDetails.set(url, getStringDetails(url, dependencies));
      }
    }
  }

  const transformedManifest = await transformManifest({
    additionalPrecacheEntries,
    dontCacheBustURLsMatching,
    manifestTransforms,
    maximumFileSizeToCacheInBytes,
    modifyURLPrefix,
    fileDetails: Array.from(allFileDetails.values()),
    disablePrecacheManifest,
  });

  transformedManifest.warnings.push(...warnings);

  return transformedManifest;
}
