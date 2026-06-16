import { Link } from 'react-router-dom';

export default function Home() {
  return (
    <section className="page home-page">
      <h1>LazyLoad</h1>
      <p className="tagline">
        Upload a screenshot of your homework. We'll turn it into a to-do list and a study plan.
      </p>
      <Link to="/upload" className="cta-button">
        Get Started
      </Link>
    </section>
  );
}
