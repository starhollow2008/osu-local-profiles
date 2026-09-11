/**
 * Just enough of a bundler to put this page's own modules into one <script>, for the shared
 * copy of the page (web/js/share-copy.js).
 *
 * The project has no build step and one feature does not justify adding one, so this handles
 * exactly the module forms the page is written in -- `import { a, b } from './x.js'`, and
 * `export function`, `export async function`, `export const`, `export class` -- and refuses
 * anything else by name. A new form in the page's code then fails the export and the tests,
 * rather than producing a copy that looks fine and runs nothing.
 *
 * Each dependency runs in a function of its own, so two modules may each have their own `$`;
 * dependencies run before what imports them, in the order they are first imported; and the
 * entry module runs at the top level, where it may `await`, exactly as it does now.
 *
 * `export let` is refused rather than copied: an imported binding here is a snapshot of the
 * value, not a live one, so a module that reassigned an exported variable would be quietly
 * wrong. Nothing in the page does; this keeps it that way.
 */

const IMPORT = /^import\s*\{([^}]*)\}\s*from\s*'\.\/([\w.-]+\.js)';?[ \t]*$/gm;
const EXPORT = /^export\s+(?:async\s+function\*?|function\*?|const|class)\s+([A-Za-z_$][\w$]*)/gm;
const UNSUPPORTED = /^(?:import\b[^\n]*|export\s+(?:default|let|var|\{|\*)[^\n]*)/m;

/** Split one module into what it imports, what it exports, and its code with neither keyword. */
function parse(path, source) {
  const imports = [];
  let body = source.replace(IMPORT, (_, names, from) => {
    imports.push({
      from,
      names: names
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
        .map((n) => {
          const [imported, local] = n.split(/\s+as\s+/);
          return { imported, local: local ?? imported };
        }),
    });
    return '';
  });

  const left = UNSUPPORTED.exec(body);
  if (left) throw new Error(`${path}: cannot bundle "${left[0].trim()}"`);
  // Matched as code is written -- a call with a quoted path, a property of the meta object --
  // so that a sentence naming them, like the one below, is not mistaken for either.
  if (/\bimport\s*\(\s*['"`]|\bimport\.meta\./.test(body)) {
    throw new Error(`${path}: cannot bundle a dynamic import or import.meta`);
  }

  const exports = [];
  body = body.replace(EXPORT, (whole, name) => {
    exports.push(name);
    return whole.replace(/^export\s+/, '');
  });
  return { imports, exports, body };
}

const scopeName = (path) => `__module_${path.replace(/\W/g, '_')}`;

/**
 * The module at `entry` and everything it imports, as one script. `load(path)` returns a
 * module's source by its file name, e.g. 'format.js'.
 */
export async function bundleModules(entry, load) {
  const modules = new Map();
  const state = new Map();
  const order = [];

  async function visit(path) {
    if (state.get(path) === 'done') return;
    if (state.get(path) === 'visiting') throw new Error(`${path} is imported in a circle; it cannot be ordered`);
    state.set(path, 'visiting');
    const module = parse(path, await load(path));
    modules.set(path, module);
    for (const { from } of module.imports) await visit(from);
    state.set(path, 'done');
    order.push(path);
  }
  await visit(entry);

  const parts = order.map((path) => {
    const module = modules.get(path);
    const bindings = module.imports.map(({ from, names }) => {
      for (const { imported } of names) {
        if (!modules.get(from).exports.includes(imported)) {
          throw new Error(`${path} imports ${imported} from ${from}, which does not export it`);
        }
      }
      const list = names.map(({ imported, local }) => (imported === local ? local : `${imported}: ${local}`));
      return `const { ${list.join(', ')} } = ${scopeName(from)};`;
    });

    if (path === entry) return `// ---- ${path}\n${bindings.join('\n')}\n${module.body}`;
    return `// ---- ${path}\nconst ${scopeName(path)} = (() => {\n${bindings.join('\n')}\n${module.body}\nreturn { ${module.exports.join(', ')} };\n})();`;
  });
  return parts.join('\n');
}
