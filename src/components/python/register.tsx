// Python support entry (docs/PYTHON.md). Order matters: interpreter state first, run infrastructure before the config types and debugger.
import { watchPythonProject } from "./interpreter";
import "../run/register";
import "./interp/register";
import "./runtypes/register";
import "./debug/register";
import "./console/register";
import "./packages/register";
import "./lang/register";

watchPythonProject();
