import { fileURLToPath } from "node:url";

/**
 * Absolute package path to the shipped application templates.
 *
 * This source is emitted at the package root in the shared dist tree so both
 * Creator profiles resolve the same package resource location.
 */
export const creatorTemplateRoot = fileURLToPath(new URL("../templates/", import.meta.url));
