/**
 * Side-effect imports. Each module owns ONE register file that registers its tool windows,
 * actions, popups and status widgets. Do not add logic here.
 */
import "./components/project/register";
import "./components/terminal/register";
import "./components/search/register";
import "./components/git/register";
import "./components/claude/register";
import "./components/remote-files/register";
import "./components/daemons/register";
import "./editor/lsp/register";
import "./components/python/register"; // Python: interpreters, run configs, debugger, console, tests, packages (docs/PYTHON.md)
import "./components/shell/RecentProjects"; // RecentProjects popup (toolbar project widget)
import "./theme/register"; // colour schemes: Settings > Appearance, Quick Switch Scheme
import "./components/gradle/register"; // Gradle tool window, pinned tasks in .ace/config.json (docs/GRADLE.md)
import "./components/godot/register"; // Godot: run configs, tool window, GDScript debugger (remote debugger), docs/GODOT.md
