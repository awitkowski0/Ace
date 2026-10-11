/** Test hooks for scripts/qa/python.mjs. Each area registers an object of helpers: `const py = await __qa.py(); py.run.start(...)`. */
const parts: Record<string, Record<string, unknown>> = {};
export const registerQa = (area: string, hooks: Record<string, unknown>) => { parts[area] = hooks; };
export const pyQa = () => parts;
