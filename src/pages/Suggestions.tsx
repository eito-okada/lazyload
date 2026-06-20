import SuggestionsList from '../components/SuggestionsList';

/**
 * Standalone email-suggestions route. Kept for back-compat / deep links; the
 * primary home for this queue is now the Inbox page. Shares one list component.
 */
export default function Suggestions() {
  return (
    <section className="page review-page">
      <SuggestionsList />
    </section>
  );
}
