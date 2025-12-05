import { useState, useRef, useEffect, useCallback } from 'react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Search, X, Scan, ExternalLink, History, Camera, ChevronLeft, ChevronRight } from 'lucide-react';
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
  const [showScanAnimation, setShowScanAnimation] = useState(false);

  // Pan/Zoom states
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

  // ✅ FIXED: Load ALL images from ALL links SIMULTANEOUSLY without delays
  const loadAllImagesSimultaneously = useCallback(async (links: string[], searchId: string) => {
    setIsAutoLoading(true);

    // ✅ Extract images from ALL links at once using Promise.all (no batching)
    const allResults = await Promise.allSettled(
      links.map(async (link) => {
        if (processedLinksRef.current.has(link)) return [];
        
        try {
          const images = await Promise.race([
            extractAllProductImages(link),
            new Promise<string[]>((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), 3000)
            )
          ]);
          
          processedLinksRef.current.add(link);
          return Array.isArray(images) ? images : [];
        } catch (error) {
          processedLinksRef.current.add(link);
          return [];
        }
      })
    );

    // ✅ Collect ALL images from ALL links
    const allNewImages = allResults
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value);

    // ✅ Update state ONCE with all images
    if (allNewImages.length > 0 && searchId === currentSearchIdRef.current) {
      setExtractedImages(prev => {
        const combined = [...prev, ...allNewImages];
        // Remove duplicates
        const unique = Array.from(new Set(combined));
        return [
          ...unique.filter(url => url.includes('/original/')),
          ...unique.filter(url => !url.includes('/original/'))
        ];
      });
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

      // ✅ Load ALL images from ALL links immediately - NO delays
      const allImagesPromises = jiomartLinks.map(async (link) => {
        try {
          const images = await extractAllProductImages(link);
          processedLinksRef.current.add(link);
          return Array.isArray(images) ? images : [];
        } catch (error) {
          processedLinksRef.current.add(link);
          return [];
        }
      });

      // ✅ Wait for ALL links to finish extracting
      const allImagesResults = await Promise.allSettled(allImagesPromises);
      
      const allImages = allImagesResults
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value);

      // ✅ Remove duplicates and prioritize 'original' resolution
      const uniqueImages = Array.from(new Set(allImages));
      const sortedImages = [
        ...uniqueImages.filter(url => url.includes('/original/')),
        ...uniqueImages.filter(url => !url.includes('/original/'))
      ];

      setExtractedImages(sortedImages);
      
      if (sortedImages.length > 0) {
        preloadImages(sortedImages, 12);
        // Update history thumbnail
        setTimeout(() => {
          saveToHistory(idToSearch, foundUrl, sortedImages[0]);
        }, 200);
        toast.success(`Loaded ${sortedImages.length} images`);
      } else {
        toast.error('No valid images found');
      }

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
  }, [productId, saveToHistory, getNextApiKey, markApiKeyExhausted, fetchWithRetry]);

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
    setShowScanAnimation(false);
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

    // Show scan animation
    setShowScanAnimation(true);
    setTimeout(() => setShowScanAnimation(false), 600);

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
        // ✅ Automatically search the first detected ID
        const firstID = uniqueIDs[0];
        setProductId(firstID);
        stopCamera();
        toast.success(`Found ${uniqueIDs.length} ID(s). Searching: ${firstID}`);
        setTimeout(() => handleSearch(firstID), 100);
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

  // Pan/Zoom handlers
  const getTouchDistance = (touch1: Touch, touch2: Touch) => {
    const dx = touch1.clientX - touch2.clientX;
    const dy = touch1.clientY - touch2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const distance = getTouchDistance(e.touches[0], e.touches[1]);
      touchStartRef.current = {
        distance,
        zoom,
        x: position.x,
        y: position.y
      };
    } else if (e.touches.length === 1) {
      swipeStartRef.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        time: Date.now()
      };
      if (zoom > 1) {
        setIsDragging(true);
        setDragStart({ x: e.touches[0].clientX - position.x, y: e.touches[0].clientY - position.y });
      }
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && touchStartRef.current) {
      e.preventDefault();
      const distance = getTouchDistance(e.touches[0], e.touches[1]);
      const scale = distance / touchStartRef.current.distance;
      const newZoom = Math.min(Math.max(touchStartRef.current.zoom * scale, 1), 5);
      setZoom(newZoom);
    } else if (e.touches.length === 1 && zoom > 1 && isDragging) {
      e.preventDefault();
      const newX = e.touches[0].clientX - dragStart.x;
      const newY = e.touches[0].clientY - dragStart.y;
      setPosition({ x: newX, y: newY });
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (swipeStartRef.current && zoom === 1 && e.changedTouches.length === 1) {
      const touch = e.changedTouches[0];
      const deltaX = touch.clientX - swipeStartRef.current.x;
      const deltaY = touch.clientY - swipeStartRef.current.y;
      const deltaTime = Date.now() - swipeStartRef.current.time;

      if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50 && deltaTime < 300) {
        if (deltaX > 0 && selectedImageIndex !== null && selectedImageIndex > 0) {
          setSelectedImageIndex(selectedImageIndex - 1);
          setZoom(1);
          setPosition({ x: 0, y: 0 });
        } else if (deltaX < 0 && selectedImageIndex !== null && selectedImageIndex < extractedImages.length - 1) {
          setSelectedImageIndex(selectedImageIndex + 1);
          setZoom(1);
          setPosition({ x: 0, y: 0 });
        }
      }
    }
    touchStartRef.current = null;
    swipeStartRef.current = null;
    setIsDragging(false);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoom > 1) {
      e.preventDefault();
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging && zoom > 1) {
      e.preventDefault();
      const newX = e.clientX - dragStart.x;
      const newY = e.clientY - dragStart.y;
      setPosition({ x: newX, y: newY });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom(prev => Math.min(Math.max(prev + delta, 1), 5));
  };

  // ✅ Arrow navigation for desktop
  const goToPrevious = () => {
    if (selectedImageIndex !== null && selectedImageIndex > 0) {
      setSelectedImageIndex(selectedImageIndex - 1);
      setZoom(1);
      setPosition({ x: 0, y: 0 });
    }
  };

  const goToNext = () => {
    if (selectedImageIndex !== null && selectedImageIndex < extractedImages.length - 1) {
      setSelectedImageIndex(selectedImageIndex + 1);
      setZoom(1);
      setPosition({ x: 0, y: 0 });
    }
  };

  useEffect(() => {
    if (zoom === 1) {
      setPosition({ x: 0, y: 0 });
    }
  }, [zoom]);

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
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 pb-6">
      {/* Compact Header */}
      <div className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b shadow-sm">
        <div className="max-w-5xl mx-auto px-4 py-3">
          <div className="flex items-center gap-2 mb-2">
            <div className="relative flex-1">
              <Input
                type="text"
                placeholder="Enter Product ID"
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="h-11 pr-11"
              />
              <Button
                size="icon"
                onClick={startCamera}
                className="absolute right-1 top-1 h-9 w-9 rounded-md"
                variant="ghost"
              >
                <Camera className="h-5 w-5" />
              </Button>
            </div>
            <Button onClick={() => handleSearch()} disabled={loading} className="h-11 px-6">
              <Search className="mr-2 h-4 w-4" />
              {loading ? 'Loading...' : 'Find'}
            </Button>
          </div>

          <div className="flex items-center justify-between text-sm">
            {extractedImages.length > 0 && (
              <>
                <div className="font-medium text-blue-600">
                  {extractedImages.length} Image{extractedImages.length !== 1 ? 's' : ''}
                  {isAutoLoading && <span className="ml-2 text-gray-500">(Loading more...)</span>}
                </div>
              </>
            )}

            <div className="flex items-center gap-2">
              {jiomartUrl && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(jiomartUrl, '_blank')}
                  className="h-8"
                >
                  <ExternalLink className="mr-1 h-3 w-3" />
                  Open Product
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowHistoryDialog(true)}
                className="h-8"
              >
                <History className="mr-1 h-3 w-3" />
                History
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-5xl mx-auto px-4 mt-6">
        {loading && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {[...Array(10)].map((_, i) => (
              <Skeleton key={i} className="aspect-square rounded-lg" />
            ))}
          </div>
        )}

        {extractedImages.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {extractedImages.map((url, index) => (
              <div
                key={index}
                className="group relative aspect-square rounded-lg overflow-hidden bg-white shadow-sm hover:shadow-xl transition-all cursor-pointer border-2 border-transparent hover:border-blue-400"
                onClick={() => {
                  setSelectedImageIndex(index);
                  setZoom(1);
                  setPosition({ x: 0, y: 0 });
                }}
              >
                <img
                  src={url}
                  alt={`Product ${index + 1}`}
                  className="w-full h-full object-contain"
                  loading="lazy"
                />
                <div className="absolute bottom-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded-full backdrop-blur-sm">
                  {index + 1}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Fullscreen Slideshow */}
      {selectedImageIndex !== null && (
        <div
          className="fixed inset-0 bg-black z-[100] flex items-center justify-center"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
        >
          <img
            src={extractedImages[selectedImageIndex]}
            alt={`Product ${selectedImageIndex + 1}`}
            className="max-w-full max-h-full object-contain select-none"
            style={{
              transform: `scale(${zoom}) translate(${position.x / zoom}px, ${position.y / zoom}px)`,
              cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
              transition: isDragging ? 'none' : 'transform 0.2s ease-out',
              touchAction: 'none',
              userSelect: 'none'
            }}
            draggable={false}
          />

          {/* Close Button */}
          <button
            onClick={() => {
              setSelectedImageIndex(null);
              setZoom(1);
              setPosition({ x: 0, y: 0 });
            }}
            className="absolute top-4 right-4 p-3 rounded-full bg-black/40 hover:bg-black/60 backdrop-blur-sm transition-all z-10"
          >
            <X className="h-6 w-6 text-white" />
          </button>

          {/* ✅ Arrow Buttons - Desktop Only */}
          {!isMobile && selectedImageIndex > 0 && (
            <button
              onClick={goToPrevious}
              className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/40 hover:bg-black/60 backdrop-blur-sm transition-all z-10"
            >
              <ChevronLeft className="h-6 w-6 text-white" />
            </button>
          )}

          {!isMobile && selectedImageIndex < extractedImages.length - 1 && (
            <button
              onClick={goToNext}
              className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/40 hover:bg-black/60 backdrop-blur-sm transition-all z-10"
            >
              <ChevronRight className="h-6 w-6 text-white" />
            </button>
          )}

          {/* Counter */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/60 text-white px-4 py-2 rounded-full backdrop-blur-sm">
            {selectedImageIndex + 1} / {extractedImages.length}
          </div>

          {/* Zoom Indicator */}
          {zoom > 1 && (
            <div className="absolute top-4 left-4 bg-black/60 text-white px-3 py-1 rounded-full backdrop-blur-sm text-sm">
              {(zoom * 100).toFixed(0)}%
            </div>
          )}
        </div>
      )}

      {/* Fullscreen OCR Camera Dialog */}
      <Dialog open={showCameraDialog} onOpenChange={(open) => !open && stopCamera()}>
        <DialogContent className="max-w-4xl max-h-[90vh] p-0">
          <DialogTitle className="sr-only">Scan Product</DialogTitle>
          <DialogDescription className="sr-only">Capture and extract product ID</DialogDescription>

          {!capturedImage ? (
            <div className="relative w-full h-[70vh] bg-black">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                className="w-full h-full object-contain"
              />
              <canvas ref={canvasRef} className="hidden" />

              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute inset-x-0 top-1/4 mx-auto w-[90%] max-w-md h-32 border-4 border-blue-500 rounded-lg shadow-2xl">
                  <div className="absolute -top-8 left-0 right-0 text-center text-white text-sm font-medium bg-black/50 py-1 rounded-t-lg">
                    Position product ID within frame
                  </div>
                </div>
              </div>

              <Button
                onClick={captureImage}
                size="lg"
                className="absolute bottom-6 left-1/2 -translate-x-1/2 w-20 h-20 rounded-full"
              >
                <Scan className="h-8 w-8" />
              </Button>
            </div>
          ) : (
            <div className="relative w-full h-[70vh] bg-black flex items-center justify-center">
              {showScanAnimation && (
                <div className="absolute inset-0 bg-white/20 animate-pulse z-10" />
              )}

              <img src={capturedImage} alt="Captured" className="max-w-full max-h-full object-contain" />

              {isProcessingOCR ? (
                <div className="absolute inset-0 flex items-center justify-center bg-black/70">
                  <div className="text-white text-xl font-semibold">Extracting text...</div>
                </div>
              ) : detectedIDs.length > 0 ? (
                <div className="absolute bottom-0 left-0 right-0 bg-white p-6 max-h-[40vh] overflow-y-auto">
                  <h3 className="font-bold text-lg mb-4">Detected Product IDs</h3>
                  <div className="space-y-2">
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
                </div>
              ) : (
                <Button
                  onClick={retakePhoto}
                  size="lg"
                  className="absolute bottom-6 left-1/2 -translate-x-1/2"
                >
                  Retake Photo
                </Button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* History Dialog */}
      <Dialog open={showHistoryDialog} onOpenChange={setShowHistoryDialog}>
        <DialogContent className="max-w-2xl max-h-[80vh]">
          <DialogTitle>Search History</DialogTitle>
          <DialogDescription>Your recent product searches</DialogDescription>

          {searchHistory.length === 0 ? (
            <div className="text-center py-12 text-gray-500">No search history yet</div>
          ) : (
            <div className="space-y-2 max-h-[50vh] overflow-y-auto">
              {searchHistory.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 border transition-all"
                >
                  {item.thumbnail && (
                    <img
                      src={item.thumbnail}
                      alt={item.productId}
                      className="w-16 h-16 object-contain rounded border"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-mono font-bold">{item.productId}</div>
                    <div className="text-sm text-gray-500">
                      {new Date(item.timestamp).toLocaleString()}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
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
                        size="sm"
                        variant="outline"
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
            <div className="mt-4">
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
                Clear All History
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};
