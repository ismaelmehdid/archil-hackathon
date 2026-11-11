'use client';
import { Component, type ReactNode } from 'react';

/** Keeps a 3D-scene crash from taking down the side panels. Retries automatically. */
export default class ArenaBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  private timer: ReturnType<typeof setTimeout> | undefined;

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.warn('[arena] 3D scene crashed, retrying in 3 s:', error.message);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.setState({ error: null }), 3000);
  }

  componentWillUnmount() {
    clearTimeout(this.timer);
  }

  render() {
    if (this.state.error)
      return (
        <div className="arena-loading">
          3D view unavailable ({this.state.error.message}). Retrying...
        </div>
      );
    return this.props.children;
  }
}
