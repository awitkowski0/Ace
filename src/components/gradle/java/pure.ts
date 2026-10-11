/** Pure helpers of the Gradle debug / hot swap module (unit tested in pure.test.ts). */

/** Gradle project paths whose tasks ran in a build, from its console (`> Task :1.20.1:compileJava` -> `:1.20.1`; root tasks -> `:`). */
export function ranProjects(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/^> Task (:[^\s]*?)[A-Za-z0-9_-]+(?: [A-Z-]+)?$/gm)) out.add(m[1].length > 1 ? m[1].replace(/:$/, "") : ":");
  return [...out];
}

/** The init-script / installation-path arguments a Debug run adds in front of the user's tasks. */
export function debugArgs(initScript: string, jbrPaths: string): string[] {
  return ["--init-script", initScript, ...(jbrPaths ? [`-Dorg.gradle.java.installations.paths=${jbrPaths}`] : [])];
}

/** Text for the hint under "Enhanced HotSwap" given the detected JetBrains Runtime versions (null = still looking). */
export function enhancedHintText(versions: string[] | null): string {
  const base = "Debug runs only: the game's JavaExec task runs on a JetBrains Runtime of the same Java version with -XX:+AllowEnhancedClassRedefinition, so a hot swap can add and remove methods and fields.";
  if (versions === null) return `${base} Looking for installed JetBrains Runtimes…`;
  if (!versions.length) return `${base} No JetBrains Runtime was found (java_home, ~/Library/Java/JavaVirtualMachines, ~/.gradle/jdks, IntelliJ's bundled one): the game would run on its normal JDK, so only method-body changes can be reloaded. Install a JBR to use this.`;
  return `${base} Found: ${versions.map((v) => `JBR ${v}`).join(", ")}. A task whose Java version has no matching JBR runs on its normal JDK (a note is printed).`;
}
