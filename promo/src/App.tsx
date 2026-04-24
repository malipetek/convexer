import React from 'react';

function App() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
      {/* Header */}
      <header className="border-b border-slate-700/50 backdrop-blur-sm bg-slate-900/50 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg" />
            <span className="text-xl font-bold">Convexer</span>
          </div>
          <nav className="flex gap-6 text-sm text-slate-300">
            <a href="#features" className="hover:text-white transition-colors">Features</a>
            <a href="#install" className="hover:text-white transition-colors">Install</a>
            <a href="https://github.com/malipetek/convexer" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">GitHub</a>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 py-24 text-center">
        <div className="inline-block px-4 py-1.5 bg-blue-500/10 border border-blue-500/30 rounded-full text-blue-400 text-sm mb-6">
          Self-Hosted Convex Instance Manager
        </div>
        <h1 className="text-5xl md:text-6xl font-bold mb-6 bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-transparent">
          Run Multiple Convex Backends on One VPS
        </h1>
        <p className="text-xl text-slate-400 mb-10 max-w-2xl mx-auto">
          Create, manage, and monitor multiple Convex-based mobile backend bundles from a single web dashboard. Save resources with shared infrastructure.
        </p>
        <div className="flex gap-4 justify-center">
          <a
            href="#install"
            className="px-6 py-3 bg-blue-600 hover:bg-blue-500 rounded-lg font-medium transition-colors"
          >
            Get Started
          </a>
          <a
            href="https://github.com/malipetek/convexer"
            target="_blank"
            rel="noopener noreferrer"
            className="px-6 py-3 bg-slate-700 hover:bg-slate-600 rounded-lg font-medium transition-colors"
          >
            View on GitHub
          </a>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="max-w-6xl mx-auto px-6 py-20">
        <h2 className="text-3xl font-bold mb-12 text-center">Features</h2>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[
            {
              title: 'Multi-Instance Management',
              desc: 'Create, start, stop, duplicate, archive, and restore Convex instances from a single dashboard.'
            },
            {
              title: 'Per-Instance Resources',
              desc: 'Each instance gets its own Convex backend, dashboard, PostgreSQL database, and optional Better Auth sidecar.'
            },
            {
              title: 'PostgreSQL Tools',
              desc: 'Browse tables, inspect schema, run SQL queries, import/export, backup, and restore databases.'
            },
            {
              title: 'Subdomain Routing',
              desc: 'Automatic Traefik-based subdomain routing for backend, site, dashboard, and auth endpoints.'
            },
            {
              title: 'Shared Infrastructure',
              desc: 'Umami analytics, GlitchTip error tracking, and backup storage shared across all instances.'
            },
            {
              title: 'Live Metrics',
              desc: 'Real-time CPU, memory, disk, and network monitoring for all instances.'
            },
            {
              title: 'Scheduled Backups',
              desc: 'Automated local and remote backup scheduling for peace of mind.'
            },
            {
              title: 'Self-Update Flow',
              desc: 'One-click updates from GitHub releases with version checking.'
            },
            {
              title: 'Push Notifications',
              desc: 'Configure per-instance push notification gateways with test sender and delivery logs.'
            }
          ].map((feature, i) => (
            <div key={i} className="p-6 bg-slate-800/50 border border-slate-700/50 rounded-xl hover:border-slate-600 transition-colors">
              <h3 className="font-semibold mb-2">{feature.title}</h3>
              <p className="text-slate-400 text-sm">{feature.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Install */}
      <section id="install" className="max-w-6xl mx-auto px-6 py-20">
        <h2 className="text-3xl font-bold mb-6 text-center">Quick Install</h2>
        <p className="text-slate-400 text-center mb-10 max-w-2xl mx-auto">
          Run this on a fresh Ubuntu/Debian server with Docker installed:
        </p>
        <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 max-w-3xl mx-auto overflow-x-auto">
          <code className="text-sm text-green-400">
            curl -fsSL https://raw.githubusercontent.com/malipetek/convexer/main/install.sh | sudo bash -s -- --domain example.com --password 'change-this-password'
          </code>
        </div>
        <p className="text-slate-500 text-center mt-6 text-sm">
          Then open <code className="text-slate-400">http://example.com</code> or <code className="text-slate-400">http://SERVER_IP:4000</code>
        </p>
      </section>

      {/* Architecture */}
      <section className="max-w-6xl mx-auto px-6 py-20">
        <h2 className="text-3xl font-bold mb-12 text-center">Architecture</h2>
        <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-8 max-w-3xl mx-auto">
          <pre className="text-sm text-slate-300 whitespace-pre-wrap font-mono">
{`convexer
  React dashboard + Express API
  SQLite metadata database
  Docker socket access

traefik
  Docker-label based routing

per app instance
  Convex backend
  Convex dashboard
  PostgreSQL
  Better Auth sidecar

shared services
  Umami analytics
  GlitchTip error tracking
  backup storage
  push notification gateway`}
          </pre>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-700/50 py-8">
        <div className="max-w-6xl mx-auto px-6 text-center text-slate-500 text-sm">
          <p>Built with React, TypeScript, Tailwind CSS, Docker, and Traefik.</p>
          <p className="mt-2">
            <a href="https://github.com/malipetek/convexer" target="_blank" rel="noopener noreferrer" className="hover:text-slate-300 transition-colors">
              GitHub
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}

export default App;
