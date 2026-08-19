/**
 * The Vault tab keeps its own layout but not its own palette: every colour it
 * paints has to come from the app-wide tokens in styles.css, so light and dark
 * stay in step with every other screen. These two checks fail the moment a raw
 * colour or an undefined token creeps back into vault.css.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const renderer = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "renderer");
const vaultCss = fs.readFileSync(path.join(renderer, "vault.css"), "utf8");
const stylesCss = fs.readFileSync(path.join(renderer, "styles.css"), "utf8");

/** A custom-property declaration: several share one line in styles.css. */
const DECL = /(?:^|[;{])\s*(--[\w-]+)\s*:/gm;

/** The modal scrim: the one colour the app has no token for. */
const ALLOWED_LITERALS = new Set(["rgba(9, 9, 11, 0.55)"]);

describe("vault.css uses the app's colour scheme", () => {
  it("paints nothing with a literal colour", () => {
    const literals = (vaultCss.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) ?? [])
      .filter((c) => !ALLOWED_LITERALS.has(c));
    expect(literals).toEqual([]);
  });

  it("every token it reads is defined here or app-wide", () => {
    const defined = new Set(
      [...vaultCss.matchAll(DECL), ...stylesCss.matchAll(DECL)]
        .map((m) => m[1]),
    );
    const used = new Set([...vaultCss.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]));
    expect([...used].filter((t) => !defined.has(t))).toEqual([]);
  });

  it("redefines no app token as itself, which would resolve to nothing", () => {
    const block = vaultCss.slice(vaultCss.indexOf(".vaultui {"), vaultCss.indexOf("}", vaultCss.indexOf(".vaultui {")));
    const cycles = [...block.matchAll(/(--[\w-]+)\s*:\s*var\((--[\w-]+)\)/g)]
      .filter((m) => m[1] === m[2])
      .map((m) => m[1]);
    expect(cycles).toEqual([]);
  });
});
