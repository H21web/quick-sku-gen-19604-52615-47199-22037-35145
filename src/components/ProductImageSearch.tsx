import { useState, useRef, useEffect, useCallback } from 'react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Search, X, ChevronLeft, ChevronRight, Scan, ExternalLink, History, Camera } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';
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

export const ProductImageSearch = () => {
  const [productId, setProductId] = useState('');
  const [extractedImages, setExtractedImages] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState<number | null>(null);
  const [showCameraDialog, setShowCameraDialog] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [isProcessingOCR, setIsProcessingOCR] = useState(false);
  const [detectedIDs, setDetectedIDs] = useState<string[]>([]);
  const [jiomartUrl, setJiomartUrl] = useState('');
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([]);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const [isAutoLoading, setIsAutoLoading] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const currentSearchIdRef = useRef('');
  const processedLinksRef = useRef<Set<string>>(new Set());
  const [apiKeyStatuses, setApiKeyStatuses] = useState<ApiKeyStatus[]>(() =>
    GOOGLE_API_KEYS.map(key => ({ key, exhausted: false, lastReset: Date.now() }))
  );
  const currentKeyIndexRef = useRef(0);
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  useEffect(() => {
    const savedHistory = localStorage.getItem('searchHistory');
    if (savedHistory) {
      try {
        setSearchHistory(JSON.parse(savedHistory));
      } catch {
        localStorage.removeItem('searchHistory');
      }
    }

    const resetInterval = setInterval(() => {
      setApiKeyStatuses(prev =>
        prev.map(status => ({
          ...status,
          exhausted: false,
          lastReset: Date.now()
        }))
      );
    }, 3600000);

    return () => clearInterval(resetInterval);
  }, []);

  const getNextApiKey = useCallback((): string | null => {
    const availableKeys = apiKeyStatuses.filter(k => !k.exhausted);
    if (availableKeys.length === 0) return null;
    const key = availableKeys[currentKeyIndexRef.current % availableKeys.length];
    currentKeyIndexRef.current++;
    return key.key;
  }, [apiKeyStatuses]);

  const markApiKeyExhausted = useCallback((apiKey: string) => {
    setApiKeyStatuses(prev =>
      prev.map(status =>
        status.key === apiKey ? { ...status, exhausted: true } : status
      )
    );
  }, []);

  const fetchWithRetry = async (
    buildUrl: (apiKey: string) => string,
    maxRetries: number = GOOGLE_API_KEYS.length
  ): Promise<Response> => {
    let attempts = 0;
    let lastError: Error | null = null;

    while (attempts < maxRetries) {
      const apiKey = getNextApiKey();
      if (!apiKey) throw new Error('All API keys exhausted. Please try again later.');

      try {
        const url = buildUrl(apiKey);
        const response = await fetch(url);
        if (response.ok) return response;

        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.error?.message || '';
        const isRateLimitError =
          response.status === 429 ||
          errorMessage.toLowerCase().includes('quota') ||
          errorMessage.toLowerCase().includes('limit') ||
          errorMessage.toLowerCase().includes('ratelimitexceeded') ||
          errorData.error?.code === 429;

        if (isRateLimitError) {
          console.warn(`API key exhausted, rotating to next key...`);
          markApiKeyExhausted(apiKey);
          attempts++;
          continue;
        }

        throw new Error(errorMessage || `API request failed with status ${response.status}`);
      } catch (error: any) {
        lastError = error;
        if (error.message.includes('fetch') || error.message.includes('network')) {
          attempts++;
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error('All API keys failed');
  };

  const saveToHistory = useCallback((productId: string, jiomartUrl?: string, thumbnail?: string) => {
    setSearchHistory((prevHistory) => {
      const existingIndex = prevHistory.findIndex(item => item.productId === productId);
      
      if (existingIndex !== -1) {
        const updatedItem = {
          ...prevHistory[existingIndex],
          timestamp: Date.now(),
          jiomartUrl: jiomartUrl || prevHistory[existingIndex].jiomartUrl,
          thumbnail: thumbnail || prevHistory[existingIndex].thumbnail
        };
        
        const updatedHistory = [
          updatedItem,
          ...prevHistory.filter((_, idx) => idx !== existingIndex)
        ].slice(0, 20);
        
        localStorage.setItem('searchHistory', JSON.stringify(updatedHistory));
        return updatedHistory;
      } else {
        const newHistoryItem: SearchHistoryItem = {
          id: Date.now().toString(),
          productId,
          timestamp: Date.now(),
          jiomartUrl,
          thumbnail
        };
        
        const updatedHistory = [newHistoryItem, ...prevHistory].slice(0, 20);
        localStorage.setItem('searchHistory', JSON.stringify(updatedHistory));
        return updatedHistory;
      }
    });
  }, []);

  // ✅ Progressive auto-loading of remaining images
  const loadRemainingImages = useCallback(async (links: string[], searchId: string) => {
    setIsAutoLoading(true);
    
    for (const link of links) {
      if (searchId !== currentSearchIdRef.current || processedLinksRef.current.has(link)) continue;
      
      try {
        const images = await Promise.race([
          extractAllProductImages(link),
          new Promise<string[]>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 3000)
          )
        ]);
        
        processedLinksRef.current.add(link);
        
        if (images.length > 0 && searchId === currentSearchIdRef.current) {
          setExtractedImages(prev => {
            const combined = [...prev, ...images];
            const unique = Array.from(new Set(combined));
            return [
              ...unique.filter(url => url.includes('/original/')),
              ...unique.filter(url => !url.includes('/original/'))
            ];
          });
        }
      } catch (error) {
        processedLinksRef.current.add(link);
      }
      
      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    setIsAutoLoading(false);
  }, []);

  const handleSearch = useCallback(async (searchId?: string) => {
    const idToSearch = searchId || productId;
    if (!idToSearch.trim()) {
      toast.error('Please enter a product ID');
      return;
    }

    if (!GOOGLE_SEARCH_ENGINE_ID) {
      toast.error('Google Search Engine ID not configured');
      return;
    }

    const newSearchId = `${idToSearch}_${Date.now()}`;
    currentSearchIdRef.current = newSearchId;

    setLoading(true);
    setExtractedImages([]);
    setJiomartUrl('');
    processedLinksRef.current.clear();

    try {
      const query = `site:jiomart.com ${idToSearch}`;

      const [imageResponse, webResponse] = await Promise.all([
        fetchWithRetry((apiKey) =>
          `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&searchType=image&num=10&fields=items(link)`
        ),
        fetchWithRetry((apiKey) =>
          `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=1&fields=items(link)`
        )
      ]);

      const [imageData, webData] = await Promise.all([
        imageResponse.json(),
        webResponse.json()
      ]);

      let foundUrl = '';
      if (webData.items?.[0]?.link?.includes('jiomart.com')) {
        foundUrl = webData.items[0].link;
        setJiomartUrl(foundUrl);
      }

      saveToHistory(idToSearch, foundUrl);

      if (!imageData.items?.length) {
        toast.error('No images found');
        return;
      }

      const jiomartLinks = Array.from(new Set(
        imageData.items
          .map((item: any) => item.link)
          .filter((url: string) => url.includes('jiomart.com/images/product'))
      )) as string[];

      if (!jiomartLinks.length) {
        toast.error('No product images found');
        return;
      }

      // ✅ Load first link immediately
      const firstLink = jiomartLinks[0];
      const firstImages = await extractAllProductImages(firstLink);
      processedLinksRef.current.add(firstLink);
      
      if (firstImages.length > 0) {
        setExtractedImages(firstImages);
        preloadImages(firstImages, 12);
        
        // Update history thumbnail
        setTimeout(() => {
          saveToHistory(idToSearch, foundUrl, firstImages[0]);
        }, 500);
      }

      // ✅ Auto-load remaining images progressively in background
      const remainingLinks = jiomartLinks.slice(1);
      if (remainingLinks.length > 0) {
        setTimeout(() => {
          loadRemainingImages(remainingLinks, newSearchId);
        }, 500);
      }

      toast.success('Images loaded!');

    } catch (error: any) {
      console.error('Search error:', error);
      if (error.message.includes('exhausted')) {
        toast.error('All API keys exhausted. Please try again in an hour.');
      } else {
        toast.error(error.message || 'Search failed. Try again.');
      }
    } finally {
      setLoading(false);
    }
  }, [productId, saveToHistory, getNextApiKey, markApiKeyExhausted, fetchWithRetry, loadRemainingImages]);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      });

      setCameraStream(stream);
      setShowCameraDialog(true);

      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      }, 100);
    } catch (error) {
      toast.error('Camera access denied or not available');
      console.error('Camera error:', error);
    }
  };

  const stopCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setShowCameraDialog(false);
    setCapturedImage(null);
    setDetectedIDs([]);
  };

  const captureImage = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = canvas.toDataURL('image/jpeg', 0.9);

    setCapturedImage(imageData);

    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }

    await extractTextFromImage(imageData);
  };

  const retakePhoto = () => {
    setCapturedImage(null);
    setDetectedIDs([]);
    startCamera();
  };

  // ✅ OPTIMIZED OCR - No timing toast
  const extractTextFromImage = async (imageData: string) => {
    setIsProcessingOCR(true);

    try {
      const img = new Image();
      img.src = imageData;
      await new Promise((resolve) => { img.onload = resolve; });

      const canvas = document.createElement('canvas');
      const maxDimension = 800;
      let width = img.width;
      let height = img.height;

      if (width > height && width > maxDimension) {
        height = (height / width) * maxDimension;
        width = maxDimension;
      } else if (height > maxDimension) {
        width = (width / height) * maxDimension;
        height = maxDimension;
      }

      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, width, height);
      }

      const compressedImage = canvas.toDataURL('image/jpeg', 0.7);

      const formData = new FormData();
      formData.append('base64Image', compressedImage);
      formData.append('apikey', OCR_SPACE_API_KEY);
      formData.append('language', 'eng');
      formData.append('isOverlayRequired', 'false');
      formData.append('detectOrientation', 'true');
      formData.append('scale', 'true');
      formData.append('OCREngine', '2');

      const response = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error('OCR failed');
      }

      const result = await response.json();

      if (result.IsErroredOnProcessing) {
        throw new Error(result.ErrorMessage?.[0] || 'OCR failed');
      }

      const extractedText = result.ParsedResults?.[0]?.ParsedText || '';

      const foundIDs = new Set<string>();
      const fullText = extractedText.replace(/\n/g, ' ');
      const cleanedText = fullText
        .replace(/[oO]/g, '0')
        .replace(/[lI|]/g, '1')
        .replace(/[sS]/g, '5')
        .replace(/[bB]/g, '8');

      const idPatterns = [
        /ID\s*[:：.,-]?\s*(\d{5,})/gi,
        /[1I]D\s*[:：.,-]?\s*(\d{5,})/gi,
        /Product\s*[:：.,-]?\s*(\d{5,})/gi,
        /Item\s*[:：.,-]?\s*(\d{5,})/gi,
        /Code\s*[:：.,-]?\s*(\d{5,})/gi,
      ];

      for (const pattern of idPatterns) {
        const matches = [...fullText.matchAll(pattern), ...cleanedText.matchAll(pattern)];
        matches.forEach(m => m[1] && foundIDs.add(m[1].replace(/\D/g, '')));
      }

      if (foundIDs.size === 0) {
        const numberMatches = [...fullText.matchAll(/\b(\d{6,12})\b/g)];
        numberMatches.forEach(m => m[1] && foundIDs.add(m[1]));
      }

      if (foundIDs.size === 0) {
        const separatedNumbers = fullText.match(/\d[\d\s\-_.]{4,}\d/g) || [];
        separatedNumbers.forEach(num => {
          const cleaned = num.replace(/\D/g, '');
          if (cleaned.length >= 6) foundIDs.add(cleaned);
        });
      }

      const uniqueIDs = Array.from(foundIDs).filter(id => id.length >= 6 && id.length <= 12);
      setDetectedIDs(uniqueIDs);

      if (uniqueIDs.length === 0) {
        toast.info('No product IDs detected');
      } else {
        toast.success(`Found ${uniqueIDs.length} product ID(s)`);
      }

    } catch (error: any) {
      console.error('OCR error:', error);
      toast.error('OCR failed. Try again.');
    } finally {
      setIsProcessingOCR(false);
    }
  };

  const useDetectedID = (id: string) => {
    setProductId(id);
    stopCamera();
    toast.success(`Searching: ${id}`);
    setTimeout(() => handleSearch(id), 50);
  };

  useEffect(() => {
    return () => {
      if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [cameraStream]);

  useEffect(() => {
    if (extractedImages.length > 0) {
      preloadImages(extractedImages, 15);
    }
  }, [extractedImages]);

  return (
    <div className="w-full min-h-screen bg-background">
      {/* Compact Header */}
      <div className="sticky top-0 z-40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b">
        <div className="max-w-7xl mx-auto p-3">
          <div className="flex gap-2">
            <Input
              placeholder="Enter Product ID"
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="flex-1 h-11"
            />
            <Button size="icon" variant="outline" onClick={startCamera} className="h-11 w-11">
              <Scan className="h-5 w-5" />
            </Button>
            <Button size="icon" variant="outline" onClick={() => setShowHistoryDialog(true)} className="h-11 w-11">
              <History className="h-5 w-5" />
            </Button>
            <Button onClick={() => handleSearch()} disabled={loading} className="h-11 px-6">
              {loading ? 'Loading...' : 'Find'}
            </Button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto p-3">
        {/* Loading Skeletons */}
        {loading && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mt-3">
            {[...Array(8)].map((_, i) => (
              <Skeleton key={i} className="aspect-square rounded-lg" />
            ))}
          </div>
        )}

        {/* Images Grid */}
        {extractedImages.length > 0 && (
          <div className="space-y-3 mt-3">
            {/* Compact Header */}
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {extractedImages.length} Images {isAutoLoading && '(Loading more...)'}
              </h2>
              {jiomartUrl && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => window.open(jiomartUrl, '_blank')}
                  className="gap-1"
                >
                  <ExternalLink className="h-3 w-3" />
                  Open
                </Button>
              )}
            </div>

            {/* Responsive Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
              {extractedImages.map((url, index) => (
                <div
                  key={`${url}-${index}`}
                  className="relative aspect-square rounded-lg overflow-hidden border cursor-pointer hover:ring-2 hover:ring-primary transition-all"
                  onClick={() => setSelectedImageIndex(index)}
                >
                  <img
                    src={url}
                    alt={`Product ${index + 1}`}
                    className="w-full h-full object-cover"
                    loading={index < 15 ? 'eager' : 'lazy'}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ✅ FULLSCREEN IMAGE VIEWER with transparent controls */}
      {selectedImageIndex !== null && (
        <div className="fixed inset-0 z-50 bg-black">
          <img
            src={extractedImages[selectedImageIndex]}
            alt={`Product ${selectedImageIndex + 1}`}
            className="w-full h-full object-contain"
          />

          {/* Transparent Close Button - Top Right */}
          <button
            onClick={() => setSelectedImageIndex(null)}
            className="absolute top-4 right-4 p-3 rounded-full bg-black/30 hover:bg-black/50 backdrop-blur-sm transition-all"
          >
            <X className="h-6 w-6 text-white" />
          </button>

          {/* Transparent Previous Button - Left */}
          {selectedImageIndex > 0 && (
            <button
              onClick={() => setSelectedImageIndex(selectedImageIndex - 1)}
              className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/30 hover:bg-black/50 backdrop-blur-sm transition-all"
            >
              <ChevronLeft className="h-8 w-8 text-white" />
            </button>
          )}

          {/* Transparent Next Button - Right */}
          {selectedImageIndex < extractedImages.length - 1 && (
            <button
              onClick={() => setSelectedImageIndex(selectedImageIndex + 1)}
              className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/30 hover:bg-black/50 backdrop-blur-sm transition-all"
            >
              <ChevronRight className="h-8 w-8 text-white" />
            </button>
          )}

          {/* Transparent Counter - Bottom Center */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-black/30 backdrop-blur-sm">
            <span className="text-white text-sm font-medium">
              {selectedImageIndex + 1} / {extractedImages.length}
            </span>
          </div>
        </div>
      )}

      {/* ✅ REDESIGNED COMPACT OCR CAMERA DIALOG */}
      <Dialog open={showCameraDialog} onOpenChange={(open) => !open && stopCamera()}>
        <DialogContent className="max-w-md p-0 gap-0">
          <DialogTitle className="sr-only">Scan Product</DialogTitle>
          <DialogDescription className="sr-only">Capture and extract product ID</DialogDescription>

          {!capturedImage ? (
            <div className="relative">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full aspect-video bg-black rounded-t-lg"
              />
              <canvas ref={canvasRef} className="hidden" />
              
              {/* Floating Capture Button */}
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
                <Button
                  onClick={captureImage}
                  size="lg"
                  className="rounded-full h-16 w-16 shadow-lg"
                >
                  <Camera className="h-8 w-8" />
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col">
              <img src={capturedImage} alt="Captured" className="w-full aspect-video object-cover rounded-t-lg" />
              <canvas ref={canvasRef} className="hidden" />

              <div className="p-4 space-y-3">
                {isProcessingOCR ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                  </div>
                ) : detectedIDs.length > 0 ? (
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {detectedIDs.map((id, index) => (
                      <button
                        key={index}
                        onClick={() => useDetectedID(id)}
                        className="w-full bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg px-4 py-3 font-mono font-bold transition-all active:scale-95 flex items-center justify-between"
                      >
                        <span>{id}</span>
                        <Search className="h-5 w-5" />
                      </button>
                    ))}
                  </div>
                ) : (
                  <Button onClick={retakePhoto} variant="outline" className="w-full">
                    Retake Photo
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* History Dialog */}
      <Dialog open={showHistoryDialog} onOpenChange={setShowHistoryDialog}>
        <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
          <DialogTitle>Search History</DialogTitle>
          <DialogDescription>Your recent product searches</DialogDescription>

          {searchHistory.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No search history yet</p>
          ) : (
            <div className="space-y-2">
              {searchHistory.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-3 p-2 border rounded-lg hover:bg-accent cursor-pointer transition-colors"
                >
                  {item.thumbnail && (
                    <img
                      src={item.thumbnail}
                      alt={item.productId}
                      className="w-12 h-12 object-cover rounded"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-sm font-semibold truncate">{item.productId}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(item.timestamp).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => {
                        setProductId(item.productId);
                        setShowHistoryDialog(false);
                        handleSearch(item.productId);
                      }}
                    >
                      <Search className="h-4 w-4" />
                    </Button>
                    {item.jiomartUrl && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={() => window.open(item.jiomartUrl, '_blank')}
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {searchHistory.length > 0 && (
            <div className="pt-2 border-t">
              <Button
                variant="destructive"
                onClick={() => {
                  setSearchHistory([]);
                  localStorage.removeItem('searchHistory');
                  toast.success('History cleared');
                }}
                className="w-full"
                size="sm"
              >
                Clear All
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};
