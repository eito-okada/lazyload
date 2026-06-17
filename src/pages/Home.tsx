import { Link } from 'react-router-dom';
import { Sparkles, ArrowRight, Clock, MapPin } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import Logo from '../components/Logo';

export default function Home() {
  const { user } = useAuth();
  const ctaTo = user ? '/today' : '/login';

  return (
    <section className="page home-page">
      <div className="home-bg" aria-hidden="true" />

      <div className="home-hero">
        <span className="eyebrow">
          <Sparkles size={14} /> AI-powered planner
        </span>

        <h1 className="home-title">
          Snap it. <span className="accent-text">Plan it.</span>
        </h1>

        <p className="tagline home-tagline">
          Take a photo of any worksheet, syllabus, or screen — LazyLoad turns it into
          a clean schedule of tasks and events in seconds.
        </p>

        <div className="home-cta">
          <Link to={ctaTo} className="btn btn-primary btn-lg">
            Get started <ArrowRight size={18} />
          </Link>
          <Link to="/add" className="btn btn-ghost btn-lg">
            Add manually
          </Link>
        </div>

        <div className="home-preview" aria-hidden="true">
          <div className="preview-head">
            <Logo size={20} />
            <span className="preview-title">Today</span>
            <span className="preview-date">Wed, Jun 17</span>
          </div>
          <div className="preview-row">
            <span className="preview-bar prio-event" />
            <div className="preview-row-body">
              <span className="preview-row-title">AP Bio Lecture</span>
              <span className="preview-row-meta">
                <Clock size={12} /> 9:00–10:30 AM <MapPin size={12} /> Room 204
              </span>
            </div>
          </div>
          <div className="preview-row">
            <span className="preview-bar prio-high" />
            <div className="preview-row-body">
              <span className="preview-row-title">Physics Homework #7</span>
              <span className="preview-row-meta">
                <Clock size={12} /> Due 10:00 PM
              </span>
            </div>
          </div>
          <div className="preview-row">
            <span className="preview-bar prio-low" />
            <div className="preview-row-body">
              <span className="preview-row-title">Read Chapter 12</span>
              <span className="preview-row-meta">Anytime</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
