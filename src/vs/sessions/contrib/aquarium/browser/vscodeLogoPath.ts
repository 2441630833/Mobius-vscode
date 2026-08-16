/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Mobius infinity silhouette for the Agents aquarium "fish".
// Each fish renders this path as live, same-document SVG geometry: fish.ts
// stores it in a shared <symbol>, then renders clipped <use> slices with
// staggered CSS animations (swimming-strip effect + currentColor tinting).
// viewBox is 0 0 96 96 to match the aquarium strip clip layout.
// Outer lemniscate + two loop holes (evenodd) ≈ the Mobius ∞ mark.
export const VSCODE_LOGO_PATH = 'M18.5 48c0-11.046 8.954-20 20-20 5.89 0 11.16 2.55 14.85 6.57C56.34 30.55 61.61 28 67.5 28c11.046 0 20 8.954 20 20s-8.954 20-20 20c-5.89 0-11.16-2.55-14.85-6.57C49.66 65.45 44.39 68 38.5 68c-11.046 0-20-8.954-20-20zm20-12c-6.627 0-12 5.373-12 12s5.373 12 12 12 12-5.373 12-12-5.373-12-12-12zm29 0c-6.627 0-12 5.373-12 12s5.373 12 12 12 12-5.373 12-12-5.373-12-12-12z';
