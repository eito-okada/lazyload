import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar';
import Home from './pages/Home';
import Upload from './pages/Upload';
import Review from './pages/Review';
import Schedule from './pages/Schedule';
import { TaskProvider } from './context/TaskContext';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <TaskProvider>
        <Navbar />
        <main className="app-main">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/upload" element={<Upload />} />
            <Route path="/review" element={<Review />} />
            <Route path="/schedule" element={<Schedule />} />
          </Routes>
        </main>
      </TaskProvider>
    </BrowserRouter>
  );
}

export default App;
