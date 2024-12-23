import { CssVarsProvider } from "@mui/joy/styles";
import CssBaseline from "@mui/joy/CssBaseline";
import { PodcastInterface } from "./PodcastInterface";

function App() {
  return (
    <CssVarsProvider defaultMode="dark">
      <CssBaseline />
      <PodcastInterface />
    </CssVarsProvider>
  );
}

export default App;
