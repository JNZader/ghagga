import { useEffect, useState } from 'react';
import {
  readExplainTourBannerDismissed,
  readExplainTourSeen,
  writeExplainTourBannerDismissed,
  writeExplainTourSeen,
} from '@/components/explain-tour/storage';

/**
 * First-visit tour state for repository and installation settings.
 * Dismissing the tour records that it was seen. Dismissing the note only
 * hides the banner, so a later visit can still auto-start the tour.
 */
export function useExplainTour(enabled: boolean, autoStart = true) {
  const [seen, setSeen] = useState(() => readExplainTourSeen());
  const [bannerDismissed, setBannerDismissed] = useState(() => readExplainTourBannerDismissed());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setOpen(false);
      return;
    }
    if (autoStart && !readExplainTourSeen()) setOpen(true);
  }, [enabled, autoStart]);

  const dismissTour = () => {
    writeExplainTourSeen();
    writeExplainTourBannerDismissed();
    setSeen(true);
    setBannerDismissed(true);
    setOpen(false);
  };

  const dismissBanner = () => {
    writeExplainTourBannerDismissed();
    setBannerDismissed(true);
  };

  const replay = () => setOpen(true);

  return {
    open: enabled && open,
    seen,
    bannerVisible: enabled && !bannerDismissed,
    dismissTour,
    dismissBanner,
    replay,
  };
}
