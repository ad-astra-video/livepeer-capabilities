import { Routes, Route } from 'react-router-dom';
import Dashboard from './Dashboard';
import AdminRoute from './AdminRoute';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/admin" element={<AdminRoute />} />
    </Routes>
  );
}
