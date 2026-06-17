import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Navbar from './components/Navbar';
import RequireAuth from './components/RequireAuth';
import Home from './pages/Home';
import Login from './pages/Login';
import Review from './pages/Review';
import Schedule from './pages/Schedule';
import Today from './pages/Today';
import AddItem from './pages/AddItem';
import { AuthProvider } from './context/AuthContext';
import { TaskProvider } from './context/TaskContext';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <TaskProvider>
          <div className="app-shell">
            <Navbar />
            <main className="app-main">
              <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/login" element={<Login />} />
              <Route path="/upload" element={<Navigate to="/add" replace />} />
              <Route
                path="/review"
                element={
                  <RequireAuth>
                    <Review />
                  </RequireAuth>
                }
              />
              <Route
                path="/schedule"
                element={
                  <RequireAuth>
                    <Schedule />
                  </RequireAuth>
                }
              />
              <Route
                path="/today"
                element={
                  <RequireAuth>
                    <Today />
                  </RequireAuth>
                }
              />
              <Route
                path="/add"
                element={
                  <RequireAuth>
                    <AddItem />
                  </RequireAuth>
                }
              />
              </Routes>
            </main>
          </div>
        </TaskProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
