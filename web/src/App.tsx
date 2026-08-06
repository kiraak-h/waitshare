import { NavLink, Route, Routes } from "react-router-dom"
import Home from "./pages/Home"
import Advertise from "./pages/Advertise"
import Leaderboard from "./pages/Leaderboard"
import Dashboard from "./pages/Dashboard"
import Install from "./pages/Install"

function Nav() {
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `nav-link${isActive ? " nav-link-active" : ""}`
  return (
    <header className="nav">
      <div className="nav-inner">
        <NavLink to="/" className="brand">
          <span className="brand-mark">K$</span>
          <span className="brand-name">WaitShare</span>
        </NavLink>
        <nav className="nav-links">
          <NavLink to="/" className={linkClass} end>
            Home
          </NavLink>
          <NavLink to="/advertise" className={linkClass}>
            Advertise
          </NavLink>
          <NavLink to="/leaderboard" className={linkClass}>
            Transparency
          </NavLink>
          <NavLink to="/install" className={linkClass}>
            Install
          </NavLink>
          <NavLink to="/dashboard" className={linkClass}>
            Earn
          </NavLink>
        </nav>
      </div>
    </header>
  )
}

export default function App() {
  return (
    <div className="app">
      <Nav />
      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/advertise" element={<Advertise />} />
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/install" element={<Install />} />
        </Routes>
      </main>
      <footer className="footer">
        <span>WaitShare — get paid for waiting. 60% to developers, locked in code.</span>
        <span>Auditable ledger. Signed updates. No prompts, ever.</span>
      </footer>
    </div>
  )
}
