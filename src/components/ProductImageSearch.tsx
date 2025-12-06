import { useState, useRef, useEffect, useCallback } from 'react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Search, X, Scan, ExternalLink, History, Camera, ChevronLeft, ChevronRight } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { toast } from 'sonner';
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

// ✅ SMART COMPONENT: Handles loading state gracefully
// Prevents layout shifts and broken image icons
const FadeInImage = ({ src, index, onClick }: { src: string, index: number, onClick: () => void }) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);

  if (hasError) return null;

  return (
    <div
      onClick={onClick}
      className="relative aspect-square border rounded-lg overflow-hidden bg-white cursor-pointer group shadow-sm hover:shadow-md transition-all"
    >
      {!isLoaded && <Skeleton className="absolute inset-0 w-full h-full animate-pulse bg-gray-100" />}
      
      <img
        src={src}
        alt={`Product ${index + 1}`}
        className={`w-full h-full object-contain p-2 transition-opacity duration-300 ${
          isLoaded ? 'opacity-100' : 'opacity-0'
        }`}
        onLoad={() => setIsLoaded(true)}
        onError={() => setHasError(true)}
        loading="lazy"
      />
      
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
  
  // Camera & OCR
  const [showCameraDialog, setShowCameraDialog] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [isProcessingOCR, setIsProcessingOCR] = useState(false);
  const [detectedIDs, setDetectedIDs] = useState<string[]>([]);
  const [showScanAnimation, setShowScanAnimation] = useState(false);

  // Data
  const [jiomartUrl, setJiomartUrl] = useState('');
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([]);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const [isAutoLoading, setIsAutoLoading] = useState(false);

  // Zoom/Pan
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  
  const touchStartRef = useRef<{ distance: number; zoom: number; x: number; y: number } | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
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

  // API Key Rotation Logic
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

  // ✅ PARALLEL LOADER: Executes immediately without delays
  const loadAllImagesSimultaneously = useCallback(async (links: string[], searchId: string) => {
    setIsAutoLoading(true);
    // Process all links at once since our extract logic is now low-bandwidth
    const batchResults = await Promise.allSettled(
      links.map(async (link) => {
        if (processedLinksRef.current.has(link)) return [];
        try {
          const images = await extractAllProductImages(link);
          processedLinksRef.current.add(link);
          return images;
        } catch {
          processedLinksRef.current.add(link);
          return [];
        }
      })
    );

    if (searchId === currentSearchIdRef.current) {
      const newImages = batchResults
        .filter((r): r is PromiseFulfilledResult<string[]> => r.status === 'fulfilled')
        .flatMap(r => r.value);
      
      if (newImages.length > 0) {
        setExtractedImages(prev => {
          const unique = Array.from(new Set([...prev, ...newImages]));
          return [...unique.filter(u => u.includes('/original/')), ...unique.filter(u => !u.includes('/original/'))];
        });
      }
    }
    setIsAutoLoading(false);
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

      // Fast Path: Process first link immediately
      const firstLink = links[0];
      extractAllProductImages(firstLink).then(images => {
        if (searchId !== currentSearchIdRef.current) return;
        processedLinksRef.current.add(firstLink);
        if (images.length) {
          setExtractedImages(images);
          preloadImages(images);
          saveToHistory(idToSearch, undefined, images[0]);
        }
      });

      // Background: Process rest immediately (non-blocking)
      if (links.length > 1) {
        loadAllImagesSimultaneously(links.slice(1), newSearchId);
      }

    } catch (e: any) {
      toast.error(e.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  }, [productId, saveToHistory, getNextApiKey, loadAllImagesSimultaneously]);

  // UI Handlers
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
      <div className="bg-white border-b px-4 py-3 sticky top-0 z-30 shadow-sm">
        <div className="flex gap-2 max-w-4xl mx-auto">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-3 h-5 w-5 text-gray-400" />
            <Input
              value={productId}
              onChange={e => setProductId(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder="Product ID"
              className="pl-10 h-11 text-lg"
              inputMode="numeric"
              pattern="[0-9]*"
            />
            {productId && <X onClick={() => setProductId('')} className="absolute right-3 top-3 h-5 w-5 text-gray-400" />}
          </div>
          <Button onClick={startCamera} variant="outline" size="icon" className="h-11 w-11"><Scan className="h-5 w-5" /></Button>
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

      {/* Grid */}
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
          <X onClick={() => setSelectedImageIndex(null)} className="absolute top-4 right-4 text-white z-50 w-8 h-8 p-1 bg-black/50 rounded-full" />
          
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
            />
          </div>
          
          <div className="absolute bottom-8 text-white bg-black/50 px-3 py-1 rounded-full text-sm">
            {selectedImageIndex + 1} / {extractedImages.length}
          </div>
          
          {selectedImageIndex > 0 && <ChevronLeft onClick={() => setSelectedImageIndex(prev => prev! - 1)} className="absolute left-2 text-white w-10 h-10 p-2 bg-black/30 rounded-full" />}
          {selectedImageIndex < extractedImages.length - 1 && <ChevronRight onClick={() => setSelectedImageIndex(prev => prev! + 1)} className="absolute right-2 text-white w-10 h-10 p-2 bg-black/30 rounded-full" />}
        </div>
      )}

      {/* Camera Dialog */}
      <Dialog open={showCameraDialog} onOpenChange={o => !o && stopCamera()}>
        <DialogContent className="p-0 h-[100dvh] sm:h-auto bg-black text-white border-none max-w-md">
          <div className="relative flex-1 h-full flex items-center justify-center bg-black">
            {!capturedImage ? (
              <>
                <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover" />
                <div className="absolute bottom-12 left-0 right-0 flex justify-center">
                  <Button onClick={captureImage} className="h-20 w-20 rounded-full border-4 border-white bg-transparent" />
                </div>
              </>
            ) : (
              <div className="relative w-full h-full">
                <img src={capturedImage} className="w-full h-full object-contain" />
                {showScanAnimation && <div className="absolute inset-0 bg-primary/20 animate-pulse" />}
                <div className="absolute bottom-0 w-full p-4 bg-black/80 space-y-3">
                  {isProcessingOCR ? <p className="text-center">Scanning ID...</p> : detectedIDs.length ? (
                    detectedIDs.map(id => <Button key={id} onClick={() => { setProductId(id); stopCamera(); handleSearch(id); }} className="w-full mb-2">{id}</Button>)
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
        <DialogContent>
          <DialogTitle>History</DialogTitle>
          <div className="max-h-[60vh] overflow-y-auto space-y-2">
            {searchHistory.map(item => (
              <div key={item.id} onClick={() => { setProductId(item.productId); setShowHistoryDialog(false); handleSearch(item.productId); }} className="flex items-center gap-3 p-2 hover:bg-gray-100 rounded border cursor-pointer">
                 <img src={item.thumbnail || ''} className="w-10 h-10 object-cover bg-gray-200 rounded" />
                 <div>
                   <div className="font-bold">{item.productId}</div>
                   <div className="text-xs text-gray-500">{new Date(item.timestamp).toLocaleDateString()}</div>
                 </div>
              </div>
            ))}
            {searchHistory.length > 0 && <Button onClick={() => { setSearchHistory([]); localStorage.removeItem('searchHistory'); }} variant="ghost" className="w-full text-red-500">Clear</Button>}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
