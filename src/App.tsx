import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import NotFound from "./pages/NotFound";
import LocationPage from "./pages/LocationPage";
import BasinsPage from "./pages/BasinsPage";
import { LOCATIONS } from "./lib/locations";

const App = () => (
  <TooltipProvider>
    <Toaster />
    <Sonner />

    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<Navigate to={`/${LOCATIONS[0].slug}`} replace />} />
        <Route path="/basins" element={<BasinsPage />} />
        {LOCATIONS.map((l) => (
          <Route key={l.slug} path={`/${l.slug}`} element={<LocationPage />} />
        ))}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  </TooltipProvider>
);

export default App;
