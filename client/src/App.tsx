import React from "react";
import { Routes, Route, Navigate, Link } from "react-router-dom";
import AdminPage from "./admin/AdminPage";
import PresenterPage from "./presenter/PresenterPage";

export default function App(){
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/presenter" replace />} />
      <Route path="/presenter" element={<PresenterPage />} />
      <Route path="/admin" element={<AdminPage />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function NotFound(){
  return (
    <div className="container">
      <div className="card" style={{ padding: 18 }}>
        <div className="kicker">404</div>
        <div className="h1">Page not found</div>
        <p className="p">ไปที่ <Link to="/admin"><b>Admin</b></Link> หรือ <Link to="/presenter"><b>Presenter</b></Link></p>
      </div>
    </div>
  );
}
