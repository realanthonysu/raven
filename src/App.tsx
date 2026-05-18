import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import TranslatePage from "./pages/TranslatePage";
import CorrectPage from "./pages/CorrectPage";
import ReadingPage from "./pages/ReadingPage";
import VocabularyPage from "./pages/VocabularyPage";
import HistoryPage from "./pages/HistoryPage";
import SettingsPage from "./pages/SettingsPage";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<TranslatePage />} />
          <Route path="/correct" element={<CorrectPage />} />
          <Route path="/reading" element={<ReadingPage />} />
          <Route path="/vocabulary" element={<VocabularyPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
