// Bundles the in-page pipeline: dist/inject.js (headless Chrome) and extension/content.js. Patches @figit/dom-to-figma so multi-line text wraps
// at the width of its block (as the browser does), not at the width of its longest line.
import fs from "node:fs";
import * as esbuild from "esbuild";

const PATCHES = [
  {
    // DOM clobbering: in <form> with <input name="type">, form.type is that input, not a
    // string — .toLowerCase() threw and the whole form (with the page around it) was lost.
    find: "\tconst inputType = element.type?.toLowerCase() || \"\";",
    replace: "\tconst inputType = typeof element.type === \"string\" ? element.type.toLowerCase() : \"\";",
  },
  {
    // Stacking-order sorting reads every child's computed style; a throw there lost the
    // whole parent. Fall back to document order.
    find: "\tconst sortedNodes = sortNodesByStackingOrder(Array.from(element.childNodes));",
    replace:
      "\tlet sortedNodes;\n\ttry {\n\t\tsortedNodes = sortNodesByStackingOrder(Array.from(element.childNodes));\n\t} catch (error) {\n\t\t(globalThis.__s2fErrors ||= []).push({ node: element, error });\n\t\tsortedNodes = Array.from(element.childNodes);\n\t}",
  },
  {
    // A node that throws during conversion used to be dropped with its whole subtree
    // (a page's entire content vanished because of one element). Record the error, put a
    // plain frame of the same box in its place and still convert its children.
    find: [
      "\t} catch (error) {",
      "\t\tconsole.warn(\"Failed to process node:\", error);",
      "\t\treturn 0;",
      "\t}",
      "}",
      "async function walkChildren(",
    ].join("\n"),
    replace: [
      "\t} catch (error) {",
      "\t\tconsole.warn(\"Failed to process node:\", error);",
      "\t\t(globalThis.__s2fErrors ||= []).push({ node, error });",
      "\t\tif (!isElementNode(node) || !node.childNodes.length) return 0;",
      "\t\ttry {",
      "\t\t\tconst guid = ctx.createGuid();",
      "\t\t\tconst rect = node.getBoundingClientRect();",
      "\t\t\tconst position = getElementPositionRelativeToParent(node);",
      "\t\t\tctx.appendChanges([{ guid, phase: \"CREATED\", parentIndex: { guid: parentGuid, position: childIndex.toString() }, type: \"FRAME\", name: node.tagName.toLowerCase(), visible: true, opacity: 1, size: { x: rect.width, y: rect.height }, transform: { m00: 1, m01: 0, m02: position.x, m10: 0, m11: 1, m12: position.y }, fillPaints: [], strokePaints: [], effects: [], frameMaskDisabled: true, stackMode: \"NONE\", ...(parentStack.isAutoLayout && { stackPositioning: \"ABSOLUTE\" }) }]);",
      "\t\t\tconst domPath = traceElement(ctx, node, \"frame\", guid, parentDomPath);",
      "\t\t\tawait walkChildren(node, guid, inheritedProperties, ctx, NO_PARENT_STACK, domPath, 0);",
      "\t\t\treturn 1;",
      "\t\t} catch {",
      "\t\t\treturn 0;",
      "\t\t}",
      "\t}",
      "}",
      "async function walkChildren(",
    ].join("\n"),
  },
  {
    find: "\tconst wrappingContainerWidth = nodeSize.width + widthBuffer;",
    replace: [
      "\tconst textBox = !isSingleLine && globalThis.__s2fTextBox ? globalThis.__s2fTextBox(node) : null;",
      "\tif (textBox) {",
      "\t\tadjustedPosition.x += textBox.dx;",
      "\t\tadjustedSize.width = textBox.width;",
      "\t}",
      "\tconst wrappingContainerWidth = textBox ? textBox.width : nodeSize.width + widthBuffer;",
    ].join("\n"),
  },
  {
    // Glyph → character index. The converter numbers glyphs by position ("firstCharacter: i"),
    // but layout drops the space at each line break, so every wrapped line was shifted by one
    // character (wrong caret mapping in Figma, and post-processing misread which glyph is a space).
    find: "\tconst characterOffsets = buildCharacterOffsets(layout);",
    replace:
      "\tconst characterOffsets = buildCharacterOffsets(layout);\n\tconst s2fCharIndex = globalThis.__s2fGlyphCharIndexes ? globalThis.__s2fGlyphCharIndexes(text, layout.positions) : null;",
  },
  {
    find: "firstCharacter: i,\n\t\t\t\t\tadvance: pos.advance / styles.fontSize,",
    replace: "firstCharacter: s2fCharIndex ? s2fCharIndex[i] : i,\n\t\t\t\t\tadvance: pos.advance / styles.fontSize,",
  },
  {
    // Expose the gradient parser for multi-layer backgrounds (src/core/backgrounds.js).
    find: "function cssBackgroundToFigmaPaints(cssBackground, box = DEFAULT_BOX) {",
    replace:
      "globalThis.__s2fCssBackground = (css, box) => cssBackgroundToFigmaPaints(css, box);\nfunction cssBackgroundToFigmaPaints(cssBackground, box = DEFAULT_BOX) {",
  },
  {
    find: "buildBaselines(layout, styles.fontSize, styles.textAlign, nodeSize.width, loadedFont.metrics)",
    replace: "buildBaselines(layout, styles.fontSize, styles.textAlign, adjustedSize.width, loadedFont.metrics)",
  },
  {
    // PostScript name from the page's own font file can belong to another cut of the family
    // (FinlandicaText-Regular for CSS family "Finlandica"). Figma looks the font up by it and
    // pastes empty text layers. Google/Figma name fonts <FamilyNoSpaces>-<StyleNoSpaces>,
    // so always synthesize that form; the file itself is only used for metrics.
    find: "postScriptName: familyWasSubstituted ? synthesizedPostScriptName : font.postscriptName ?? synthesizedPostScriptName",
    replace: "postScriptName: synthesizedPostScriptName",
  },
];

const patchPlugin = {
  name: "patch-dom-to-figma",
  setup(build) {
    build.onLoad({ filter: /@figit[\\/]dom-to-figma[\\/]dist[\\/]figma\.mjs$/ }, async (args) => {
      let code = await fs.promises.readFile(args.path, "utf8");
      for (const { find, replace } of PATCHES) {
        const count = code.split(find).length - 1;
        if (count !== 1) throw new Error(`dom-to-figma patch target found ${count} times (library changed?): ${find}`);
        code = code.replace(find, replace);
      }
      return { contents: code, loader: "js" };
    });
  },
};

const common = { bundle: true, format: "iife", minify: true, target: "chrome110", plugins: [patchPlugin] };
await esbuild.build({ ...common, entryPoints: ["src/inject.js"], outfile: "dist/inject.js" });
await esbuild.build({ ...common, entryPoints: ["src/extension/content.js"], outfile: "extension/content.js" });
console.log("built dist/inject.js, extension/content.js");
