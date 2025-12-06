import { useState, useRef, useEffect, useCallback } from 'react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Search, X, Scan, ExternalLink, History, Camera, ChevronLeft, ChevronRight } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { toast } from 'sonner';
// Ensure you are using the optimized extractor provided in the previous step
import { extractAllProductImages, preloadImages } from '@/lib/imageExtractor';
import { GOOGLE_SEARCH_ENGINE_ID } from '@/lib/config';
import { Skeleton } from './ui/skeleton';

const OCR_SPACE_API_KEY = 'K86120042088957';
const GOOGLE_API_KEYS = [
  'AIzaSyCUb-RrSjsScT_gfhmdyOMVp3ZHSSsai1U',
  'AIzaSyDVvxwYZzZAOLy5Cd3FMNrQKcxZxldsJCY',
  'AIzaSyBdRbGEG_nLOhaI1_RpNTN6kiwhEVcuxXo',
  'AIzaSyDsTLL2TqDbV2DhXEwxny_5VIb1IjmQVn0',
  'AIzaSyC0RGsJ8Q0Ery9CjyLBEp25REWV_SqpQPE',
  'AIzaSyB5tGVlcRpnrRkfrttWo4kMK1-9PGj15y4'
];

interface SearchHistoryItem {
  id: string;
  productId: string;
  timestamp: number;
  jiomartUrl?: string;
  thumbnail?: string;
}

interface ApiKeyStatus {
  key: string;
  exhausted: boolean;
  lastReset: number;
}

// ✅ 1. SMART IMAGE COMPONENT
// Handles auto-triggering visibility and prevents layout shifts
const FadeInImage = ({ src, index, onClick }: { src: string, index: number, onClick: () => void }) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);

  if (hasError) return null;

  return (
    <div
      onClick={onClick}
      className="relative aspect-square border rounded-lg overflow-hidden bg-white cursor-pointer group shadow-sm hover:shadow-md transition-all"
    >
      {/* Skeleton shows until image is fully loaded */}
      {!isLoaded && <Skeleton className="absolute inset-0 w-full h-full animate-pulse bg-gray-100" />}
      
      <img
        src={src}
        alt={`Product ${index + 1}`}
        // ✅ Browser-native lazy loading
        loading="lazy"
        onLoad={() => setIsLoaded(true)}
        onError={() => setHasError(true)}
        className={`w-full h-full object-contain p-2 transition-opacity duration-300 ease-out ${
          isLoaded ? 'opacity-100' : 'opacity-0'
        }`}
      />
      
      {/* Index badge (only visible when loaded) */}
      {isLoaded && (
        <div className="absolute top-1 left-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded-full opacity-0 group-hover:opacity-100 transition-opacity backdrop-blur-sm">
          {index + 1}
        </div>
      )}
    </div>
  );
};

export const ProductImageSearch = () => {
  const [productId, setProductId] = useState('');
  const [extractedImages, setExtractedImages] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState<number | null>(null);
  
  // Camera & OCR States
  const [showCameraDialog, setShowCameraDialog] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [isProcessingOCR, setIsProcessingOCR] = useState(false);
  const [detectedIDs, setDetectedIDs] = useState<string[]>([]);
  const [showScanAnimation, setShowScanAnimation] = useState(false);

  // Data States
  const [jiomartUrl, setJiomartUrl] = useState('');
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([]);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const [isAutoLoading, setIsAutoLoading] = useState(false);

  // Pan/Zoom States
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  
  const touchStartRef = useRef<{ distance: number; zoom: number; x: number; y: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const currentSearchIdRef = useRef('');
  const processedLinksRef = useRef<Set<string>>(new Set());
  const currentKeyIndexRef = useRef(0);

  const [apiKeyStatuses, setApiKeyStatuses] = useState<ApiKeyStatus[]>(() =>
    GOOGLE_API_KEYS.map(key => ({ key, exhausted: false, lastReset: Date.now() }))
  );

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  useEffect(() => {
    const savedHistory = localStorage.getItem('searchHistory');
    if (savedHistory) {
      try { setSearchHistory(JSON.parse(savedHistory)); } catch { localStorage.removeItem('searchHistory'); }
    }
  }, []);

  // --- API Key Management (Same as before) ---
  const getNextApiKey = useCallback((): string | null => {
    const availableKeys = apiKeyStatuses.filter(k => !k.exhausted);
    if (availableKeys.length === 0) return null;
    const key = availableKeys[currentKeyIndexRef.current % availableKeys.length];
    currentKeyIndexRef.current++;
    return key.key;
  }, [apiKeyStatuses]);

  const markApiKeyExhausted = useCallback((apiKey: string) => {
    setApiKeyStatuses(prev => prev.map(s => s.key === apiKey ? { ...s, exhausted: true } : s));
  }, []);

  const fetchWithRetry = async (buildUrl: (apiKey: string) => string): Promise<Response> => {
    let attempts = 0;
    while (attempts < GOOGLE_API_KEYS.length) {
      const apiKey = getNextApiKey();
      if (!apiKey) throw new Error('All API keys exhausted.');
      try {
        const response = await fetch(buildUrl(apiKey));
        if (response.ok) return response;
        if (response.status === 429) {
          markApiKeyExhausted(apiKey);
          attempts++;
          continue;
        }
        throw new Error(`API Error: ${response.status}`);
      } catch (error) {
        attempts++;
      }
    }
    throw new Error('Network failed');
  };

  const saveToHistory = useCallback((pid: string, url?: string, thumb?: string) => {
    setSearchHistory(prev => {
      const filtered = prev.filter(item => item.productId !== pid);
      const newItem: SearchHistoryItem = {
        id: Date.now().toString(),
        productId: pid,
        timestamp: Date.now(),
        jiomartUrl: url || prev.find(p => p.productId === pid)?.jiomartUrl,
        thumbnail: thumb || prev.find(p => p.productId === pid)?.thumbnail
      };
      const updated = [newItem, ...filtered].slice(0, 20);
      localStorage.setItem('searchHistory', JSON.stringify(updated));
      return updated;
    });
  }, []);

  // ✅ 2. PROGRESSIVE AUTO-LOADER
  // Updates the UI *immediately* when any image is found, instead of waiting for batches.
  const loadAllImagesSimultaneously = useCallback(async (links: string[], searchId: string) => {
    setIsAutoLoading(true);
    
    // Fire all requests in parallel
    const promises = links.map(async (link) => {
      // Skip if we already checked this link in this session
      if (processedLinksRef.current.has(link)) return;
      
      try {
        processedLinksRef.current.add(link);
        
        // Use the fast extractor
        const newImages = await extractAllProductImages(link);
        
        // Progressive Update: Update state as soon as THIS link finishes
        if (newImages.length > 0 && searchId === currentSearchIdRef.current) {
          setExtractedImages(prev => {
            const combined = [...prev, ...newImages];
            // Remove duplicates
            const unique = Array.from(new Set(combined));
            
            // Sort high-res to top, maintain others
            return [
              ...unique.filter(u => u.includes('/original/')),
              ...unique.filter(u => !u.includes('/original/'))
            ];
          });
          
          // Auto-trigger preload for these new images
          preloadImages(newImages, 4);
        }
      } catch (e) {
        console.error('Link extraction failed', link);
      }
    });

    // Wait for all to finish just to turn off the loading indicator
    await Promise.allSettled(promises);
    
    if (searchId === currentSearchIdRef.current) {
      setIsAutoLoading(false);
    }
  }, []);

  const handleSearch = useCallback(async (searchId?: string) => {
    const idToSearch = searchId || productId;
    if (!idToSearch.trim()) return toast.error('Enter Product ID');
    if (!GOOGLE_SEARCH_ENGINE_ID) return toast.error('Config Missing');

    const newSearchId = `${idToSearch}_${Date.now()}`;
    currentSearchIdRef.current = newSearchId;
    
    setLoading(true);
    setExtractedImages([]);
    setJiomartUrl('');
    processedLinksRef.current.clear();

    try {
      const query = `site:jiomart.com ${idToSearch}`;
      const [imgRes, webRes] = await Promise.all([
        fetchWithRetry(k => `https://www.googleapis.com/customsearch/v1?key=${k}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&searchType=image&num=10&fields=items(link)`),
        fetchWithRetry(k => `https://www.googleapis.com/customsearch/v1?key=${k}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=1&fields=items(link)`)
      ]);

      const [imgData, webData] = await Promise.all([imgRes.json(), webRes.json()]);
      
      if (webData.items?.[0]?.link?.includes('jiomart.com')) {
        setJiomartUrl(webData.items[0].link);
        saveToHistory(idToSearch, webData.items[0].link);
      }

      const links = Array.from(new Set(
        (imgData.items || [])
          .map((i: any) => i.link)
          .filter((l: string) => l.includes('jiomart.com/images/product'))
      )) as string[];

      if (!links.length) {
        setLoading(false);
        return toast.error('No images found');
      }

      // ⚡ Step 1: Load FIRST link instantly for immediate feedback
      const firstLink = links[0];
      extractAllProductImages(firstLink).then(images => {
        if (newSearchId !== currentSearchIdRef.current) return;
        processedLinksRef.current.add(firstLink);
        
        if (images.length) {
          setExtractedImages(images);
          preloadImages(images, 8); // Preload more aggressively
          saveToHistory(idToSearch, undefined, images[0]);
        }
      });

      // ⚡ Step 2: Auto-load REST of the links in parallel (Progressive)
      if (links.length > 1) {
        loadAllImagesSimultaneously(links.slice(1), newSearchId);
      }

    } catch (e: any) {
      toast.error(e.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  }, [productId, saveToHistory, getNextApiKey, loadAllImagesSimultaneously]);

  // --- Camera & UI Handlers ---
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      setCameraStream(stream);
      setShowCameraDialog(true);
      if (videoRef.current) videoRef.current.srcObject = stream;
    } catch { toast.error('Camera Error'); }
  };

  const stopCamera = () => {
    cameraStream?.getTracks().forEach(t => t.stop());
    setCameraStream(null);
    setShowCameraDialog(false);
    setCapturedImage(null);
  };

  const captureImage = async () => {
    if (!videoRef.current || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    canvasRef.current.width = videoRef.current.videoWidth;
    canvasRef.current.height = videoRef.current.videoHeight;
    ctx?.drawImage(videoRef.current, 0, 0);
    const data = canvasRef.current.toDataURL('image/jpeg', 0.8);
    setCapturedImage(data);
    setShowScanAnimation(true);
    setTimeout(() => setShowScanAnimation(false), 600);
    extractTextFromImage(data);
  };

  const extractTextFromImage = async (base64: string) => {
    setIsProcessingOCR(true);
    try {
      const formData = new FormData();
      formData.append('base64Image', base64);
      formData.append('apikey', OCR_SPACE_API_KEY);
      formData.append('OCREngine', '2');
      
      const res = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: formData });
      const data = await res.json();
      
      if (data.IsErroredOnProcessing) throw new Error();
      
      const text = data.ParsedResults?.[0]?.ParsedText || '';
      const numbers = text.match(/\d{6,12}/g) || [];
      const unique = [...new Set(numbers)];
      
      setDetectedIDs(unique);
      if (unique.length) {
        setProductId(unique[0]);
        stopCamera();
        handleSearch(unique[0]);
      } else {
        toast.info('No ID found');
      }
    } catch {
      toast.error('OCR Failed');
    } finally {
      setIsProcessingOCR(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-4 py-3 sticky top-0 z-30 shadow-sm safe-area-top">
        <div className="flex gap-2 max-w-4xl mx-auto">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-3 h-5 w-5 text-gray-400" />
            {/* ✅ 3. NUMBER PAD ENABLED */}
            <Input
              value={productId}
              onChange={e => setProductId(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder="Product ID"
              className="pl-10 pr-10 h-11 text-lg"
              type="text" 
              inputMode="numeric" 
              pattern="[0-9]*"
            />
            {productId && <button onClick={() => setProductId('')} className="absolute right-3 top-3 p-1"><X className="h-5 w-5 text-gray-400" /></button>}
          </div>
          <Button onClick={startCamera} variant="outline" size="icon" className="h-11 w-11 shrink-0"><Scan className="h-5 w-5" /></Button>
          <Button onClick={() => handleSearch()} disabled={loading} className="h-11 px-6">{loading ? '...' : 'Find'}</Button>
        </div>
        
        {/* Status Bar */}
        {(extractedImages.length > 0 || jiomartUrl || searchHistory.length > 0) && (
          <div className="flex justify-between mt-3 max-w-4xl mx-auto text-sm text-gray-600">
            <span className="bg-green-100 text-green-800 px-2 py-0.5 rounded-full text-xs font-bold">
              {extractedImages.length} Images {isAutoLoading && '...'}
            </span>
            <div className="flex gap-2">
              {jiomartUrl && <Button variant="ghost" size="sm" onClick={() => window.open(jiomartUrl)} className="h-7"><ExternalLink className="h-3 w-3 mr-1"/> Open</Button>}
              <Button variant="ghost" size="sm" onClick={() => setShowHistoryDialog(true)} className="h-7"><History className="h-3 w-3 mr-1"/> History</Button>
            </div>
          </div>
        )}
      </div>

      {/* Grid Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading && !extractedImages.length && (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3 max-w-4xl mx-auto">
            {[...Array(10)].map((_, i) => <Skeleton key={i} className="aspect-square rounded-lg" />)}
          </div>
        )}
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3 max-w-4xl mx-auto pb-24">
          {extractedImages.map((url, i) => (
            <FadeInImage 
              key={`${url}-${i}`} 
              src={url} 
              index={i} 
              onClick={() => { setSelectedImageIndex(i); setZoom(1); setPosition({x:0,y:0}); }} 
            />
          ))}
        </div>
      </div>

      {/* Fullscreen Viewer */}
      {selectedImageIndex !== null && (
        <div className="fixed inset-0 z-50 bg-black flex items-center justify-center touch-none">
          <button onClick={() => setSelectedImageIndex(null)} className="absolute top-4 right-4 text-white z-50 p-2 bg-black/40 rounded-full backdrop-blur-sm">
            <X className="w-6 h-6" />
          </button>
          
          <div 
            className="relative w-full h-full flex items-center justify-center"
            onTouchStart={(e) => {
              if(e.touches.length === 2) {
                const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
                touchStartRef.current = { distance: d, zoom, x: position.x, y: position.y };
              }
            }}
            onTouchMove={(e) => {
               if(e.touches.length === 2 && touchStartRef.current) {
                 const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
                 setZoom(Math.min(Math.max(touchStartRef.current.zoom * (d/touchStartRef.current.distance), 1), 4));
               }
            }}
          >
            <img 
              src={extractedImages[selectedImageIndex]} 
              className="max-w-full max-h-full object-contain transition-transform duration-100"
              style={{ transform: `scale(${zoom})` }}
              alt="Fullscreen view"
            />
          </div>
          
          <div className="absolute bottom-8 text-white bg-black/50 px-3 py-1 rounded-full text-sm backdrop-blur-sm">
            {selectedImageIndex + 1} / {extractedImages.length}
          </div>
          
          {!isMobile && selectedImageIndex > 0 && <button onClick={() => setSelectedImageIndex(prev => prev! - 1)} className="absolute left-4 text-white p-3 bg-black/30 rounded-full hover:bg-black/50"><ChevronLeft className="w-8 h-8" /></button>}
          {!isMobile && selectedImageIndex < extractedImages.length - 1 && <button onClick={() => setSelectedImageIndex(prev => prev! + 1)} className="absolute right-4 text-white p-3 bg-black/30 rounded-full hover:bg-black/50"><ChevronRight className="w-8 h-8" /></button>}
        </div>
      )}

      {/* Camera Dialog */}
      <Dialog open={showCameraDialog} onOpenChange={o => !o && stopCamera()}>
        <DialogContent className="p-0 h-[100dvh] sm:h-auto bg-black text-white border-none max-w-md flex flex-col">
          <div className="p-4 flex justify-between items-center bg-black/50 absolute top-0 w-full z-10">
            <DialogTitle>Scan Product</DialogTitle>
            <X onClick={stopCamera} className="w-6 h-6" />
          </div>
          <div className="relative flex-1 flex items-center justify-center bg-black overflow-hidden">
            {!capturedImage ? (
              <>
                <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover" />
                <div className="absolute inset-0 border-[40px] border-black/50 pointer-events-none">
                  <div className="w-full h-full border-2 border-white/50" />
                </div>
                <div className="absolute bottom-12 left-0 right-0 flex justify-center z-20">
                  <Button onClick={captureImage} className="h-20 w-20 rounded-full border-4 border-white bg-transparent hover:bg-white/20" />
                </div>
              </>
            ) : (
              <div className="relative w-full h-full flex flex-col">
                <img src={capturedImage} className="w-full h-full object-contain flex-1" alt="Captured" />
                {showScanAnimation && <div className="absolute inset-0 bg-primary/20 animate-scan" />}
                <div className="p-4 bg-zinc-900 space-y-3 pb-8">
                  {isProcessingOCR ? (
                    <div className="text-center py-2 text-gray-300">Scanning ID...</div>
                  ) : detectedIDs.length ? (
                    <div className="space-y-2">
                      <div className="text-sm text-gray-400">Detected:</div>
                      <div className="grid grid-cols-2 gap-2">
                        {detectedIDs.map(id => (
                          <Button key={id} onClick={() => { setProductId(id); stopCamera(); handleSearch(id); }} variant="secondary" className="justify-between">
                            {id} <ChevronRight className="w-4 h-4 opacity-50" />
                          </Button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <Button onClick={() => { setCapturedImage(null); startCamera(); }} variant="destructive" className="w-full">Retake</Button>
                  )}
                </div>
              </div>
            )}
            <canvas ref={canvasRef} className="hidden" />
          </div>
        </DialogContent>
      </Dialog>

      {/* History Dialog */}
      <Dialog open={showHistoryDialog} onOpenChange={setShowHistoryDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>History</DialogTitle>
          <div className="max-h-[60vh] overflow-y-auto space-y-2">
            {searchHistory.map(item => (
              <div key={item.id} onClick={() => { setProductId(item.productId); setShowHistoryDialog(false); handleSearch(item.productId); }} className="flex items-center gap-3 p-2 hover:bg-gray-100 rounded border cursor-pointer transition-colors">
                 <div className="w-12 h-12 bg-gray-100 rounded flex-shrink-0 overflow-hidden">
                   {item.thumbnail ? <img src={item.thumbnail} className="w-full h-full object-cover" /> : <Search className="w-5 h-5 m-auto text-gray-300 mt-3"/>}
                 </div>
                 <div>
                   <div className="font-bold">{item.productId}</div>
                   <div className="text-xs text-gray-500">{new Date(item.timestamp).toLocaleDateString()}</div>
                 </div>
              </div>
            ))}
            {searchHistory.length > 0 && <Button onClick={() => { setSearchHistory([]); localStorage.removeItem('searchHistory'); }} variant="ghost" className="w-full text-red-500 hover:bg-red-50">Clear History</Button>}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
