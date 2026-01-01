import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from './ui/button';

export const UpdateNotification = () => {
    const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);

    useEffect(() => {
        // Only run in production or if SW is supported
        if (!('serviceWorker' in navigator)) return;

        // Check if there's already a waiting worker on load
        navigator.serviceWorker.getRegistration().then((registration) => {
            if (registration && registration.waiting) {
                setWaitingWorker(registration.waiting);
            }
        });

        const handleUpdateFound = () => {
            navigator.serviceWorker.getRegistration().then((registration) => {
                if (!registration) return;

                const newWorker = registration.installing;
                if (newWorker) {
                    newWorker.addEventListener('statechange', () => {
                        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            setWaitingWorker(newWorker);
                        }
                    });
                }
            });
        };

        // Listen for new service workers
        // The 'updatefound' event is fired on the registration
        navigator.serviceWorker.getRegistration().then(reg => {
            if (reg) {
                reg.addEventListener('updatefound', () => {
                    const newWorker = reg.installing;
                    if (newWorker) {
                        newWorker.addEventListener('statechange', () => {
                            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                setWaitingWorker(newWorker);
                            }
                        })
                    }
                })
            }
        });

        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!refreshing) {
                refreshing = true;
                window.location.reload();
            }
        });

    }, []);

    useEffect(() => {
        if (waitingWorker) {
            toast.custom((t) => (
                <div className="bg-background border border-border p-4 rounded-lg shadow-lg flex flex-col gap-3 w-full max-w-sm">
                    <div className="flex flex-col gap-1">
                        <h3 className="font-semibold text-foreground">Update Available</h3>
                        <p className="text-sm text-muted-foreground">
                            A new version of the app is available. Update to get the latest features.
                        </p>
                    </div>
                    <div className="flex gap-2 justify-end">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => toast.dismiss(t)}
                        >
                            Later
                        </Button>
                        <Button
                            size="sm"
                            onClick={() => {
                                waitingWorker.postMessage({ type: 'SKIP_WAITING' });
                                toast.dismiss(t);
                            }}
                        >
                            Update Now
                        </Button>
                    </div>
                </div>
            ), {
                duration: Infinity, // Don't auto-dismiss
                position: 'bottom-right',
            });
        }
    }, [waitingWorker]);

    return null; // This component doesn't render anything itself, it uses toast
};
