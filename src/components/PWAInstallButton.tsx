import React, { useState } from 'react';
import { Download, ExternalLink, Smartphone } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, isInIframe, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className="inline-flex items-center gap-2 rounded-lg bg-blue-900 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer min-h-[40px]"
      >
        <Download className="w-4 h-4" />
        Install App
      </button>
    );
  }

  const currentUrl = typeof window !== 'undefined' ? window.location.href : '/';

  return (
    <>
      <button
        type="button"
        onClick={() => setShowGuide(true)}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer min-h-[40px]"
      >
        <Smartphone className="w-4 h-4 text-blue-900" />
        Install PWA
      </button>

      {showGuide && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl border border-slate-200">
            <h3 className="text-lg font-bold text-slate-900">Install Safal Academy Live</h3>

            {isInIframe ? (
              <div className="mt-3 space-y-3 text-sm text-slate-700 leading-relaxed">
                <p className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-amber-900 text-xs font-medium">
                  Preview frame ke andar browser PWA install block karta hai. Install karne ke liye pehle app ko alag Chrome/browser tab me kholen.
                </p>
                <a
                  href={currentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setShowGuide(false)}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-blue-900 py-2.5 px-4 text-sm font-semibold text-white hover:bg-blue-800 transition-colors"
                >
                  <ExternalLink className="w-4 h-4" />
                  Open Full Screen to Install
                </a>
                <p className="text-xs text-slate-500">
                  Naye tab me khulne ke baad upar <strong>Install App</strong> button ya Chrome menu (⋮) → <strong>Add to Home screen / Install app</strong> par tap karen.
                </p>
              </div>
            ) : isIOS ? (
              <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                1. Safari ke niche <strong>Share</strong> icon par tap karen.
                <br />
                2. Niche scroll karke <strong>Add to Home Screen</strong> par tap karen.
              </p>
            ) : (
              <div className="mt-2 space-y-2 text-sm text-slate-600 leading-relaxed">
                <p>
                  1. Chrome / Edge ke top-right menu (<strong>⋮</strong>) par tap karen.
                  <br />
                  2. <strong>Install app</strong> ya <strong>Add to Home screen</strong> chunen (agar &quot;Create shortcut&quot; dikhe to ek baar page reload karke 3–5 second ruken).
                </p>
                <p className="text-xs text-slate-500">
                  Note: Incognito mode me PWA install option nahi aata — normal Chrome window use karen.
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="mt-4 w-full rounded-xl border border-slate-300 bg-slate-50 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
};
