import { describe, it, expect } from "vitest";
import { __testing } from "./worldBuilderRefine.js";

const {
  extractRefinementJson,
  buildWorldRefinePrompt,
  collapseStyleDirectionDupes,
} = __testing;

describe("worldBuilderRefine.extractRefinementJson", () => {
  it("parses a raw refinement object", () => {
    const obj = {
      starterPrompt: "a darker scavenger world",
      stylePrompt: "gritty palette, deep shadows",
      negativePrompt: "cute, neon",
      rationale: "pushed mood toward grim",
    };
    expect(extractRefinementJson(JSON.stringify(obj))).toEqual(obj);
  });

  it("strips ```json fences", () => {
    const fenced =
      '```json\n{"starterPrompt":"x","stylePrompt":"y","negativePrompt":""}\n```';
    expect(extractRefinementJson(fenced)).toMatchObject({
      starterPrompt: "x",
      stylePrompt: "y",
    });
  });

  it("skips preamble before the JSON", () => {
    const raw =
      'Here is the refinement:\n{"starterPrompt":"x","stylePrompt":"y"}\nend';
    expect(extractRefinementJson(raw)).toMatchObject({ starterPrompt: "x" });
  });

  it("skips a schema-example block that has a <…> placeholder starterPrompt and parses the real block (Codex CLI prompt echo)", () => {
    const raw = [
      "codex banner",
      // The prompt template body — its first balanced { ... } block contains
      // <…> placeholders that walked past extractRefinementJson by mistake
      // would surface as "AI returned schema placeholder" instead of finding
      // the real response below it.
      '{"starterPrompt":"<full rewritten…>","stylePrompt":"<…>","negativePrompt":"<…>"}',
      "codex response:",
      '{"starterPrompt":"a darker world","stylePrompt":"gritty","negativePrompt":""}',
    ].join("\n");
    const out = extractRefinementJson(raw);
    expect(out.starterPrompt).toBe("a darker world");
    expect(out.stylePrompt).toBe("gritty");
  });

  it("throws when ONLY schema-placeholder blocks are present", () => {
    const raw = '{"starterPrompt":"<placeholder>","stylePrompt":"<x>"}';
    expect(() => extractRefinementJson(raw)).toThrow(/schema placeholder/);
  });

  it("throws on empty / non-string input", () => {
    expect(() => extractRefinementJson("")).toThrow(/Empty AI response/);
    expect(() => extractRefinementJson(null)).toThrow(/Empty AI response/);
  });

  it("throws when no balanced JSON object with starterPrompt is present", () => {
    expect(() => extractRefinementJson("just prose, no json")).toThrow(
      /Invalid JSON/,
    );
    expect(() => extractRefinementJson('{"prompt":"unrelated shape"}')).toThrow(
      /Invalid JSON/,
    );
  });
});

describe("worldBuilderRefine.buildWorldRefinePrompt", () => {
  it("includes all three originals + feedback verbatim", () => {
    const out = buildWorldRefinePrompt({
      starterPrompt: "moebius scavengers",
      stylePrompt: "comic ink, dust palette",
      negativePrompt: "lowres",
      feedback: "lean grimmer and more spiritual",
    });
    expect(out).toContain("moebius scavengers");
    expect(out).toContain("comic ink, dust palette");
    expect(out).toContain("lowres");
    expect(out).toContain("lean grimmer and more spiritual");
    // Schema must mention the three output keys so the LLM can comply.
    expect(out).toContain('"starterPrompt"');
    expect(out).toContain('"stylePrompt"');
    expect(out).toContain('"negativePrompt"');
  });

  it("substitutes (empty) for missing originals so the LLM sees the slot", () => {
    const out = buildWorldRefinePrompt({
      starterPrompt: "seed",
      stylePrompt: "",
      negativePrompt: "",
      feedback: "go dark",
    });
    expect(out).toMatch(/ORIGINAL STYLE PROMPT:\n\(empty\)/);
    expect(out).toMatch(/ORIGINAL NEGATIVE PROMPT:\n\(empty\)/);
    expect(out).toMatch(/ORIGINAL LOGLINE:\n\(empty\)/);
    expect(out).toMatch(/ORIGINAL PREMISE:\n\(empty\)/);
    expect(out).toMatch(/ORIGINAL STYLE NOTES:\n\(empty\)/);
  });

  it("includes bible context (logline / premise / styleNotes) when provided", () => {
    const out = buildWorldRefinePrompt({
      starterPrompt: "seed",
      stylePrompt: "s",
      negativePrompt: "",
      logline: "A foundry city goes silent.",
      premise: "Three families inherit the silence.",
      styleNotes: "Tarkovsky pacing, Moebius palette.",
      feedback: "go grimmer",
    });
    expect(out).toContain("A foundry city goes silent.");
    expect(out).toContain("Three families inherit the silence.");
    expect(out).toContain("Tarkovsky pacing, Moebius palette.");
    // Schema must declare the new output keys so the LLM emits them.
    expect(out).toContain('"logline"');
    expect(out).toContain('"premise"');
    expect(out).toContain('"styleNotes"');
  });

  it("emits a LOCKED FIELDS section when fields are pinned", () => {
    const out = buildWorldRefinePrompt({
      starterPrompt: "seed",
      stylePrompt: "",
      negativePrompt: "",
      logline: "L",
      premise: "",
      styleNotes: "",
      locked: { logline: true, styleNotes: true },
      feedback: "go grimmer",
    });
    expect(out).toContain("LOCKED FIELDS");
    expect(out).toContain("logline");
    expect(out).toContain("style notes");
    // The "echo unchanged" rule must appear so the LLM doesn't try to rewrite.
    expect(out).toMatch(/echo them back UNCHANGED/);
  });

  it("omits the LOCKED FIELDS section entirely when nothing is locked", () => {
    const out = buildWorldRefinePrompt({
      starterPrompt: "seed",
      stylePrompt: "",
      negativePrompt: "",
      feedback: "x",
    });
    expect(out).not.toContain("LOCKED FIELDS");
  });

  it("declares the structured influences schema in the output contract", () => {
    const out = buildWorldRefinePrompt({
      starterPrompt: "seed",
      stylePrompt: "",
      negativePrompt: "",
      feedback: "x",
    });
    // Structured influences replaced the legacy "Style direction:" clause —
    // the renderer prepends them deterministically so the LLM has to populate
    // them for re-expansions to inherit direction.
    expect(out).toContain('"influences"');
    expect(out).toContain('"embrace"');
    expect(out).toContain('"avoid"');
    // And the starter idea should stay a clean seed (no style-direction prose).
    expect(out).toMatch(/do NOT append style direction prose here/);
  });

  it("embeds prior influences as ORIGINAL INFLUENCES context", () => {
    const out = buildWorldRefinePrompt({
      starterPrompt: "seed",
      stylePrompt: "",
      negativePrompt: "",
      influences: {
        embrace: ["Moebius", "cel-shading"],
        avoid: ["Ghibli painterly"],
      },
      feedback: "lean indie comic",
    });
    expect(out).toMatch(/ORIGINAL INFLUENCES:/);
    expect(out).toContain("Embrace: Moebius, cel-shading");
    expect(out).toContain("Avoid: Ghibli painterly");
  });

  it("renders ORIGINAL INFLUENCES with (none) when lists are empty", () => {
    const out = buildWorldRefinePrompt({
      starterPrompt: "seed",
      stylePrompt: "",
      negativePrompt: "",
      feedback: "x",
    });
    expect(out).toMatch(/Embrace: \(none\)/);
    expect(out).toMatch(/Avoid: \(none\)/);
  });
});

describe("worldBuilderRefine.collapseStyleDirectionDupes", () => {
  it("returns input untouched when no Style direction block is present", () => {
    expect(collapseStyleDirectionDupes("a foundry city goes silent")).toBe(
      "a foundry city goes silent",
    );
  });

  it("returns input untouched when exactly one Style direction block is present", () => {
    const input =
      "A foundry city.\n\nStyle direction: Moebius palette, oil-on-canvas grain.";
    expect(collapseStyleDirectionDupes(input)).toBe(input);
  });

  it("collapses two Style direction blocks, keeping the LATEST one", () => {
    const input = [
      "A foundry city.",
      "",
      "Style direction: painterly Ghibli palette.",
      "",
      "Style direction: indie comic Moebius, cel-shading, simple palette.",
    ].join("\n");
    const out = collapseStyleDirectionDupes(input);
    expect(out).not.toContain("painterly Ghibli");
    expect(out).toContain("indie comic Moebius");
    // The seed core is preserved.
    expect(out).toContain("A foundry city.");
    // Exactly one Style direction occurrence remains.
    expect((out.match(/Style direction:/gi) || []).length).toBe(1);
  });

  it("handles arbitrary numbers of stale Style direction blocks", () => {
    const input = [
      "core",
      "Style direction: A",
      "Style direction: B",
      "Style direction: C",
    ].join("\n");
    const out = collapseStyleDirectionDupes(input);
    expect(out).toContain("Style direction: C");
    expect(out).not.toMatch(/Style direction: A/);
    expect(out).not.toMatch(/Style direction: B/);
  });

  it("is case-insensitive on the heading", () => {
    const input = "core\n\nstyle direction: lower\n\nStyle Direction: upper";
    const out = collapseStyleDirectionDupes(input);
    expect((out.match(/style direction:/gi) || []).length).toBe(1);
    expect(out).toContain("Style Direction: upper");
  });
});
