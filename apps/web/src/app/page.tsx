'use client';
import dynamic from 'next/dynamic';
import Header from '../ui/Header';
import ArenaBoundary from '../ui/ArenaBoundary';
import { useFeed } from '../ui/feed';
import { AnswersPanel, HistoryPanel, LiveVotesPanel, LobbyCard, RefereeCard, ThoughtsPanel } from '../ui/Panels';
import { Banner, PhaseCaption, SelectedAgentPanel, WinnerOverlay } from '../ui/Overlays';

const Arena = dynamic(() => import('../scene/Arena'), {
  ssr: false,
  loading: () => <div className="arena-loading">Loading arena...</div>,
});

export default function Page() {
  useFeed();
  return (
    <div className="app">
      <Header />
      <Banner />
      <main className="main">
        <div className="arena">
          <ArenaBoundary>
            <Arena />
          </ArenaBoundary>
          <PhaseCaption />
          <SelectedAgentPanel />
        </div>
        <aside className="side">
          <LobbyCard />
          <RefereeCard />
          <AnswersPanel />
          <LiveVotesPanel />
          <HistoryPanel />
          <ThoughtsPanel />
        </aside>
      </main>
      <WinnerOverlay />
    </div>
  );
}
