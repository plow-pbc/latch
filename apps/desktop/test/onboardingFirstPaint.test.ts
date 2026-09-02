import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktop = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(relative: string): string {
  return fs.readFileSync(path.join(desktop, relative), "utf8");
}

function ruleHas(css: string, selector: string, declaration: RegExp): boolean {
  const rules = css.matchAll(/([^{}]+)\{([^{}]*)\}/g);
  return Array.from(rules).some(([, selectors, body]) =>
    selectors.split(",").map((part) => part.trim()).includes(selector) && declaration.test(body));
}

describe("onboarding first paint", () => {
  it("keeps setup hidden until its renderer is ready, including repeat open requests", () => {
    const main = source("src/main.ts");
    const start = main.indexOf("function openOnboardingWindow(): void");
    const end = main.indexOf("/**\n * The login gate", start);
    const openOnboardingWindow = main.slice(start, end);

    expect(openOnboardingWindow).toMatch(/show:\s*false,/);
    expect(openOnboardingWindow).toMatch(
      /if \(onboardingWindowReady === onboardingWindow\) onboardingWindow\.show\(\);/,
    );
    expect(openOnboardingWindow).toMatch(
      /\.once\("ready-to-show",\s*\(\)\s*=>\s*\{[\s\S]*?onboardingWindowReady = win;[\s\S]*?win\.show\(\);[\s\S]*?\}\);/,
    );
  });

  it("starts Welcome hidden, but rests visibly when motion is reduced", () => {
    const css = source("src/renderer/onboarding.css");
    const reducedMotion = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));

    expect(ruleHas(css, ".welcome-logo .plw-mark", /fill-opacity:\s*0;/)).toBe(true);
    for (const selector of [".welcome-eyebrow", ".welcome-wrap h1", ".welcome-lead"]) {
      expect(ruleHas(css, selector, /opacity:\s*0;/)).toBe(true);
      const restingSelector = `.wizard-screen.is-welcome ${selector.replace(".welcome-wrap ", "")}`;
      expect(ruleHas(reducedMotion, restingSelector, /opacity:\s*1\s*!important;/)).toBe(true);
    }
    expect(ruleHas(
      reducedMotion,
      ".wizard-screen.is-welcome .plw-mark",
      /animation:\s*none\s*!important;/,
    )).toBe(true);
    expect(ruleHas(
      reducedMotion,
      ".wizard-screen.is-welcome .plw-mark",
      /fill-opacity:\s*1\s*!important;/,
    )).toBe(true);
  });

  it("uses a sub-half-second fade with no stroke draw on repeat visits", () => {
    const css = source("src/renderer/onboarding.css");

    expect(ruleHas(
      css,
      ".wizard-screen.is-welcome.entering-short .plw-mark",
      /animation:\s*none;/,
    )).toBe(true);
    expect(ruleHas(
      css,
      ".wizard-screen.is-welcome.entering-short .welcome-logo",
      /animation:\s*welcome-short-fade\s+400ms/,
    )).toBe(true);
    expect(ruleHas(
      css,
      "body.on-welcome.welcome-short .wizard-footer .nav-next",
      /animation:\s*welcome-short-fade\s+400ms/,
    )).toBe(true);
  });

  it("keeps an in-progress Welcome on same-step renders and has a resting fallback", () => {
    const renderer = source("src/renderer/onboarding.js");
    const css = source("src/renderer/onboarding.css");

    expect(renderer).toMatch(
      /const continuingWelcome = state\.step === "welcome" && screen\.classList\.contains\("is-welcome"\);/,
    );
    expect(renderer).toMatch(/if \(state\.step === "welcome" && !continuingWelcome\)/);
    expect(renderer).toMatch(/screen\.classList\.add\("no-entrance"\)/);
    expect(ruleHas(
      css,
      ".wizard-screen.is-welcome.no-entrance .plw-mark",
      /fill-opacity:\s*1;/,
    )).toBe(true);
  });
});
