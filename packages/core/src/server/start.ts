import { startServer } from "./index";
import { detectMux } from "../mux/detect";
import { TmuxProvider } from "../mux/tmux";

const mux = detectMux() ?? new TmuxProvider();
startServer(mux);
