import { useState, useRef, useEffect, useCallback } from 'react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Search, X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Scan, ExternalLink, History } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';
import { toast } from 'sonner';
import { extractAllProductImages } from '@/lib/imageExtractor';
import { GOOGLE_API_KEYS, GOOGLE_SEARCH_ENGINE_ID } from '@/lib/config';
import { Skeleton } from './ui/skeleton';

const OCR_SPACE_API_KEY = 'K86120042088957';


interface ImageResult {
  imageUrl: string;
  title: string;
}

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
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const imageRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<{ distance: number; zoom: number; x: number; y: number } | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const lastTapRef = useRef<number>(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [showCameraDialog, setShowCameraDialog] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [isProcessingOCR, setIsProcessingOCR] = useState(false);
  const [extractedText, setExtractedText] = useState<string>('');
  const [detectedIDs, setDetectedIDs] = useState<string[]>([]);
  const [selectableTexts, setSelectableTexts] = useState<Array<{ text: string; isNumber: boolean }>>([]);
  const [jiomartUrl, setJiomartUrl] = useState<string>('');
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([]);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const [searchTime, setSearchTime] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  
  // ✅ API Key rotation state
  const [apiKeyStatuses, setApiKeyStatuses] = useState<ApiKeyStatus[]>(() =>
    GOOGLE_API_KEYS.map(key => ({ key, exhausted: false, lastReset: Date.now() }))
  );
  const currentKeyIndexRef = useRef(0);

  // Load search history from localStorage
  useEffect(() => {
    const savedHistory = localStorage.getItem('searchHistory');
    if (savedHistory) {
      try {
        setSearchHistory(JSON.parse(savedHistory));
      } catch {
        localStorage.removeItem('searchHistory');
      }
    }

    // Reset exhausted API keys every hour
    const resetInterval = setInterval(() => {
      setApiKeyStatuses(prev => 
        prev.map(status => ({
          ...status,
          exhausted: false,
          lastReset: Date.now()
        }))
      );
    }, 3600000); // 1 hour

    return () => clearInterval(resetInterval);
  }, []);

  // ✅ Get next available API key with rotation
  const getNextApiKey = useCallback((): string | null => {
    const availableKeys = apiKeyStatuses.filter(k => !k.exhausted);
    
    if (availableKeys.length === 0) {
      return null;
    }

    // Round-robin selection
    const key = availableKeys[currentKeyIndexRef.current % availableKeys.length];
    currentKeyIndexRef.current++;
    
    return key.key;
  }, [apiKeyStatuses]);

  // ✅ Mark API key as exhausted
  const markApiKeyExhausted = useCallback((apiKey: string) => {
    setApiKeyStatuses(prev =>
      prev.map(status =>
        status.key === apiKey
          ? { ...status, exhausted: true }
          : status
      )
    );
  }, []);

  // ✅ Fetch with automatic API key rotation and retry
  const fetchWithRetry = async (
    buildUrl: (apiKey: string) => string,
    maxRetries: number = GOOGLE_API_KEYS.length
  ): Promise<Response> => {
    let attempts = 0;
    let lastError: Error | null = null;

    while (attempts < maxRetries) {
      const apiKey = getNextApiKey();
      
      if (!apiKey) {
        throw new Error('All API keys exhausted. Please try again later.');
      }

      try {
        const url = buildUrl(apiKey);
        const response = await fetch(url);

        if (response.ok) {
          return response;
        }

        // Check for rate limit errors
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
          continue; // Try next API key
        }

        // Non-rate-limit error, throw immediately
        throw new Error(errorMessage || `API request failed with status ${response.status}`);
        
      } catch (error: any) {
        lastError = error;
        
        // Network errors - try next key
        if (error.message.includes('fetch') || error.message.includes('network')) {
          attempts++;
          continue;
        }
        
        // Other errors - throw immediately
        throw error;
      }
    }

    throw lastError || new Error('All API keys failed');
  };

  // ✅ Optimized parallel image preloader - loads ALL images at once
  const preloadAllImages = useCallback((images: string[]) => {
    // Abort previous loading
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    // Load ALL images in parallel immediately
    images.forEach((url) => {
      if (signal.aborted) return;
      
      const img = new Image();
      img.onload = () => {
        if (!signal.aborted) {
          setLoadedImages(prev => new Set([...prev, url]));
        }
      };
      img.onerror = () => {
        console.warn('Failed to load:', url);
      };
      img.src = url;
    });
  }, []);

  // Save search to history
  const saveToHistory = useCallback((productId: string, jiomartUrl?: string, thumbnail?: string) => {
    setSearchHistory((prevHistory) => {
      const existingIndex = prevHistory.findIndex(item => item.productId === productId);
      
      if (existingIndex !== -1) {
        const updatedHistory = [...prevHistory];
        const existingItem = updatedHistory[existingIndex];
        updatedHistory.splice(existingIndex, 1);
        updatedHistory.unshift({
          ...existingItem,
          timestamp: Date.now(),
          jiomartUrl: jiomartUrl || existingItem.jiomartUrl,
          thumbnail: thumbnail || existingItem.thumbnail
        });
        localStorage.setItem('searchHistory', JSON.stringify(updatedHistory));
        return updatedHistory;
      }
      
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
    });
  }, []);

  // ✅ FIXED: Complete rewrite with proper image extraction and API rotation
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

    // Abort any ongoing operations
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const startTime = performance.now();
    setLoading(true);
    
    // Clear previous results IMMEDIATELY
    setExtractedImages([]);
    setLoadedImages(new Set());
    setJiomartUrl('');
    setSearchTime(null);
    
    try {
      const query = `site:jiomart.com ${idToSearch}`;
      
      // ✅ Parallel API calls with automatic retry and key rotation
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
      
      // Extract JioMart URL
      let foundUrl = '';
      if (webData.items?.[0]?.link?.includes('jiomart.com')) {
        foundUrl = webData.items[0].link;
      }
      
      if (!imageData.items?.length) {
        toast.error('No images found');
        setJiomartUrl(foundUrl);
        saveToHistory(idToSearch, foundUrl);
        setSearchTime((performance.now() - startTime) / 1000);
        return;
      }

      // Get unique JioMart image links
      const jiomartLinks = Array.from(new Set(
        imageData.items
          .map((item: any) => item.link)
          .filter((url: string) => url.includes('jiomart.com/images/product'))
      ));

      if (!jiomartLinks.length) {
        toast.error('No product images found');
        setJiomartUrl(foundUrl);
        saveToHistory(idToSearch, foundUrl);
        setSearchTime((performance.now() - startTime) / 1000);
        return;
      }

      // ✅ FIXED: Extract ALL images from ALL links in parallel with proper error handling
      const extractImageFromLink = async (url: string): Promise<string[]> => {
        try {
          const result = await Promise.race([
            extractAllProductImages(url),
            new Promise<never>((_, reject) => 
              setTimeout(() => reject(new Error('timeout')), 5000)
            )
          ]);
          return Array.isArray(result) ? result : [];
        } catch (error) {
          console.warn(`Failed to extract images from ${url}:`, error);
          return [];
        }
      };

      // Extract from ALL links in parallel
      const allImageArrays = await Promise.all(
        jiomartLinks.map(link => extractImageFromLink(link as string))
      );

      // Flatten all results
      const allImages = allImageArrays.flat();

      if (!allImages.length) {
        toast.error('No product images found');
        setJiomartUrl(foundUrl);
        saveToHistory(idToSearch, foundUrl);
        setSearchTime((performance.now() - startTime) / 1000);
        return;
      }

      // Filter unique images
      const uniqueImages = Array.from(new Set(allImages));
      
      // Sort: original images first, then others
      const sortedImages = [
        ...uniqueImages.filter(url => url.includes('/original/')),
        ...uniqueImages.filter(url => !url.includes('/original/'))
      ];
      
      if (!sortedImages.length) {
        toast.error('No images found');
        setJiomartUrl(foundUrl);
        saveToHistory(idToSearch, foundUrl);
        setSearchTime((performance.now() - startTime) / 1000);
        return;
      }

      // ✅ Set images AND start loading TOGETHER
      setExtractedImages(sortedImages);
      setJiomartUrl(foundUrl);
      
      // Start parallel image loading immediately
      preloadAllImages(sortedImages);
      
      // Save to history
      saveToHistory(idToSearch, foundUrl, sortedImages[0]);
      
      toast.success(`Found ${sortedImages.length} images`);
      setSearchTime((performance.now() - startTime) / 1000);
      
    } catch (error: any) {
      console.error('Search error:', error);
      
      // Only show error if ALL API keys failed
      if (error.message.includes('exhausted')) {
        toast.error('All API keys exhausted. Please try again in an hour.');
      } else {
        toast.error(error.message || 'Search failed. Try again.');
      }
      
      setSearchTime((performance.now() - startTime) / 1000);
    } finally {
      setLoading(false);
    }
  }, [productId, saveToHistory, preloadAllImages, getNextApiKey, markApiKeyExhausted, fetchWithRetry]);

  const openImage = (index: number) => {
    setSelectedImageIndex(index);
    setZoom(1);
    setPosition({ x: 0, y: 0 });
  };

  const closeImage = () => {
    setSelectedImageIndex(null);
    setZoom(1);
    setPosition({ x: 0, y: 0 });
  };

  const goToPrevious = () => {
    if (selectedImageIndex !== null && selectedImageIndex > 0 && !isTransitioning) {
      setIsTransitioning(true);
      setZoom(1);
      setPosition({ x: 0, y: 0 });
      setTimeout(() => {
        setSelectedImageIndex(selectedImageIndex - 1);
        setIsTransitioning(false);
      }, 100);
    }
  };

  const goToNext = () => {
    if (selectedImageIndex !== null && selectedImageIndex < extractedImages.length - 1 && !isTransitioning) {
      setIsTransitioning(true);
      setZoom(1);
      setPosition({ x: 0, y: 0 });
      setTimeout(() => {
        setSelectedImageIndex(selectedImageIndex + 1);
        setIsTransitioning(false);
      }, 100);
    }
  };

  const handleZoomIn = () => {
    setZoom(prev => Math.min(prev + 0.25, 5));
  };

  const handleZoomOut = () => {
    setZoom(prev => Math.max(prev - 0.25, 0.5));
  };

  // Touch event handlers
  const getTouchDistance = (touch1: React.Touch, touch2: React.Touch) => {
    const dx = touch1.clientX - touch2.clientX;
    const dy = touch1.clientY - touch2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const handleDoubleTap = (e: React.TouchEvent) => {
    const now = Date.now();
    const DOUBLE_TAP_DELAY = 300;
    
    if (now - lastTapRef.current < DOUBLE_TAP_DELAY) {
      e.preventDefault();
      setIsTransitioning(true);
      if (zoom === 1) {
        setZoom(2);
      } else {
        setZoom(1);
        setPosition({ x: 0, y: 0 });
      }
      setTimeout(() => setIsTransitioning(false), 300);
      lastTapRef.current = 0;
    } else {
      lastTapRef.current = now;
    }
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
      handleDoubleTap(e);
      swipeStartRef.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        time: Date.now()
      };
      if (zoom > 1) {
        setDragStart({ x: e.touches[0].clientX - position.x, y: e.touches[0].clientY - position.y });
      }
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && touchStartRef.current) {
      e.preventDefault();
      const distance = getTouchDistance(e.touches[0], e.touches[1]);
      const scale = distance / touchStartRef.current.distance;
      const newZoom = Math.min(Math.max(touchStartRef.current.zoom * scale, 0.5), 5);
      setZoom(newZoom);
    } else if (e.touches.length === 1 && zoom > 1 && swipeStartRef.current) {
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
          goToPrevious();
        } else if (deltaX < 0 && selectedImageIndex !== null && selectedImageIndex < extractedImages.length - 1) {
          goToNext();
        }
      }
    }
    touchStartRef.current = null;
    swipeStartRef.current = null;
  };

  // Mouse drag handlers
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

  const handleMouseLeave = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    if (zoom === 1) {
      setPosition({ x: 0, y: 0 });
    }
  }, [zoom]);

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
    setExtractedText('');
    setDetectedIDs([]);
    setSelectableTexts([]);
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
    
    const imageData = canvas.toDataURL('image/jpeg', 0.92);
    setCapturedImage(imageData);
    
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }

    await extractTextFromImage(imageData);
  };

  const retakePhoto = () => {
    setCapturedImage(null);
    setExtractedText('');
    setDetectedIDs([]);
    setSelectableTexts([]);
    startCamera();
  };

  // Optimized OCR with reduced image size
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
        ctx.filter = 'contrast(1.3) brightness(1.1)';
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
      formData.append('isTable', 'false');

      const response = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error('OCR request failed');
      }

      const result = await response.json();
      
      if (result.IsErroredOnProcessing) {
        throw new Error(result.ErrorMessage?.[0] || 'OCR processing failed');
      }

      const extractedText = result.ParsedResults?.[0]?.ParsedText || '';
      setExtractedText(extractedText);
      
      const words = extractedText.split(/\s+/).filter(w => w.trim());
      const selectable = words.map((word) => ({
        text: word.trim(),
        isNumber: /\d{5,}/.test(word) || /\d{3,}/.test(word)
      }));
      
      setSelectableTexts(selectable);
      
      // ID extraction
      const foundIDs = new Set<string>();
      const fullText = extractedText.replace(/\n/g, ' ');
      
      const cleanedText = fullText
        .replace(/[oO]/g, '0')
        .replace(/[lI|]/g, '1')
        .replace(/[sS]/g, '5')
        .replace(/[bB]/g, '8')
        .replace(/[zZ]/g, '2');
      
      const idPatterns = [
        /(?:ID|[1I]D|Product|Item|Code)\s*[:：.,-]?\s*(\d{5,})/gi,
        /\b(\d{6,12})\b/g,
      ];
      
      for (const pattern of idPatterns) {
        const matches = [...fullText.matchAll(pattern), ...cleanedText.matchAll(pattern)];
        matches.forEach(m => {
          const id = m[1] ? m[1].replace(/\D/g, '') : m[0].replace(/\D/g, '');
          if (id && id.length >= 5 && id.length <= 12) {
            foundIDs.add(id);
          }
        });
      }
      
      const continuousNumbers = fullText.match(/\d[\d\s\-_.]{4,}\d/g) || [];
      continuousNumbers.forEach(num => {
        const cleaned = num.replace(/\D/g, '');
        if (cleaned.length >= 5 && cleaned.length <= 12) {
          foundIDs.add(cleaned);
        }
      });
      
      const uniqueIDs = Array.from(foundIDs);
      setDetectedIDs(uniqueIDs);
      
      if (uniqueIDs.length === 0) {
        toast.info('No IDs detected. Tap any text to search.');
      } else {
        toast.success(`Found ${uniqueIDs.length} product ID(s)`);
      }
    } catch (error: any) {
      console.error('OCR error:', error);
      toast.error('OCR failed. Please try again with better lighting.');
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

  const handleTextSelect = (text: string) => {
    const numbers = text.match(/\d+/g);
    const searchText = numbers ? numbers.join('') : text;
    
    setProductId(searchText);
    stopCamera();
    toast.success(`Searching: ${searchText}`);
    setTimeout(() => handleSearch(searchText), 50);
  };

  useEffect(() => {
    return () => {
      if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [cameraStream]);

  return (
    <div className="space-y-4">
      {/* Search Section */}
      <div className="flex gap-2">
        <Input
          type="text"
          placeholder="Enter product ID"
          value={productId}
          onChange={(e) => setProductId(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          className="flex-1"
        />
        <Button 
          variant="outline" 
          size="icon" 
          onClick={startCamera} 
          title="Scan product ID"
        >
          <Scan className="w-4 h-4" />
        </Button>
        <Button onClick={() => handleSearch()} disabled={loading}>
          <Search className="w-4 h-4 mr-2" />
          {loading ? 'Finding...' : 'Find'}
        </Button>
      </div>

      {/* API Key Status Indicator */}
      <div className="text-xs text-muted-foreground">
        Active Keys: {apiKeyStatuses.filter(k => !k.exhausted).length}/{GOOGLE_API_KEYS.length}
      </div>

      {/* Loading Skeletons */}
      {loading && (
        <div className="space-y-3">
          <Skeleton className="h-6 w-48" />
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {[...Array(8)].map((_, i) => (
              <Skeleton key={i} className="w-full aspect-square rounded-lg" />
            ))}
          </div>
        </div>
      )}

      {/* Images show immediately with loading indicators */}
      {extractedImages.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-medium">Product Images ({extractedImages.length})</h3>
              {searchTime !== null && (
                <span className="text-xs text-muted-foreground">
                  {searchTime.toFixed(2)}s
                </span>
              )}
              {loadedImages.size < extractedImages.length && (
                <span className="text-xs text-primary flex items-center gap-1.5">
                  <span className="w-3 h-3 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                  {loadedImages.size}/{extractedImages.length}
                </span>
              )}
            </div>
            {jiomartUrl && (
              <Button
                variant="default"
                size="sm"
                onClick={() => window.open(jiomartUrl, '_blank')}
                className="gap-2"
              >
                <ExternalLink className="w-4 h-4" />
                Open Product
              </Button>
            )}
          </div>
          
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {extractedImages.map((url, index) => {
              const isLoaded = loadedImages.has(url);
              return (
                <div
                  key={url}
                  className="relative aspect-square rounded-lg border border-border hover:border-primary transition-all duration-200 overflow-hidden cursor-pointer group bg-muted/50"
                  onClick={() => openImage(index)}
                >
                  {!isLoaded && (
                    <div className="absolute inset-0 bg-muted animate-pulse" />
                  )}
                  
                  <img
                    src={url}
                    alt={`Product ${index + 1}`}
                    className={`w-full h-full object-cover transition-all duration-300 group-hover:scale-105 ${
                      isLoaded ? 'opacity-100' : 'opacity-0'
                    }`}
                    loading={index < 4 ? 'eager' : 'lazy'}
                    decoding="async"
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Image Viewer Dialog - Same as before */}
      <Dialog open={selectedImageIndex !== null} onOpenChange={(open) => !open && closeImage()}>
        <DialogContent className="max-w-full max-h-full w-screen h-screen p-0 bg-background/95 backdrop-blur border-0">
          <div className="sr-only">
            <DialogTitle>Product Image Viewer</DialogTitle>
            <DialogDescription>View and navigate product images</DialogDescription>
          </div>
          {selectedImageIndex !== null && (
            <div className="relative w-full h-screen flex items-center justify-center">
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-4 right-4 z-10 bg-background/80 hover:bg-background"
                onClick={closeImage}
              >
                <X className="w-5 h-5" />
              </Button>

              <div className="absolute top-4 left-4 z-10 flex gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="bg-background/80 hover:bg-background"
                  onClick={handleZoomOut}
                  disabled={zoom <= 0.5}
                >
                  <ZoomOut className="w-5 h-5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="bg-background/80 hover:bg-background"
                  onClick={handleZoomIn}
                  disabled={zoom >= 5}
                >
                  <ZoomIn className="w-5 h-5" />
                </Button>
              </div>

              {selectedImageIndex > 0 && (
                <div
                  className="absolute left-4 top-1/2 -translate-y-1/2 z-10 cursor-pointer text-foreground/80 hover:text-foreground transition-colors"
                  onClick={goToPrevious}
                >
                  <ChevronLeft className="w-8 h-8" />
                </div>
              )}

              <div 
                className="w-full h-full flex items-center justify-center"
                onClick={closeImage}
              >
                <div 
                  ref={imageRef}
                  className="relative w-full h-full flex items-center justify-center touch-none select-none"
                  onClick={(e) => e.stopPropagation()}
                  onTouchStart={handleTouchStart}
                  onTouchMove={handleTouchMove}
                  onTouchEnd={handleTouchEnd}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseLeave}
                >
                  <img
                    src={extractedImages[selectedImageIndex]}
                    alt={`Product ${selectedImageIndex + 1}`}
                    style={{ 
                      transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})`, 
                      transition: (isDragging || touchStartRef.current) && !isTransitioning 
                        ? 'none' 
                        : 'transform 0.25s cubic-bezier(0.22, 1, 0.36, 1)',
                      cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
                      transformOrigin: 'center center',
                      userSelect: 'none',
                      WebkitUserSelect: 'none',
                      touchAction: 'none',
                      willChange: 'transform'
                    }}
                    className="max-w-[80vw] max-h-[80vh] object-contain"
                    draggable={false}
                  />
                </div>
              </div>

              {selectedImageIndex < extractedImages.length - 1 && (
                <div
                  className="absolute right-4 top-1/2 -translate-y-1/2 z-10 cursor-pointer text-foreground/80 hover:text-foreground transition-colors"
                  onClick={goToNext}
                >
                  <ChevronRight className="w-8 h-8" />
                </div>
              )}

              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 bg-background/80 px-3 py-1 rounded-full text-sm">
                {selectedImageIndex + 1} / {extractedImages.length}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Camera Dialog - Same as before */}
      <Dialog open={showCameraDialog} onOpenChange={(open) => !open && stopCamera()}>
        <DialogContent className="max-w-full max-h-full w-screen h-screen p-0 bg-black">
          <div className="sr-only">
            <DialogTitle>Camera Scanner</DialogTitle>
            <DialogDescription>Capture product image for text extraction</DialogDescription>
          </div>
          
          <div className="relative w-full h-full">
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-4 right-4 z-20 bg-black/50 hover:bg-black/70 text-white"
              onClick={stopCamera}
            >
              <X className="w-5 h-5" />
            </Button>

            {!capturedImage ? (
              <>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
                <canvas ref={canvasRef} className="hidden" />
                
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="relative w-[85%] max-w-md aspect-[3/2] border-2 border-primary/60 rounded-lg">
                    <div className="absolute -top-1 -left-1 w-6 h-6 border-t-4 border-l-4 border-primary rounded-tl" />
                    <div className="absolute -top-1 -right-1 w-6 h-6 border-t-4 border-r-4 border-primary rounded-tr" />
                    <div className="absolute -bottom-1 -left-1 w-6 h-6 border-b-4 border-l-4 border-primary rounded-bl" />
                    <div className="absolute -bottom-1 -right-1 w-6 h-6 border-b-4 border-r-4 border-primary rounded-br" />
                  </div>
                </div>

                <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/80 to-transparent">
                  <p className="text-white text-center mb-4 text-sm">
                    Position product ID within the frame
                  </p>
                  <Button 
                    onClick={captureImage}
                    className="w-full"
                    size="lg"
                  >
                    <Scan className="w-5 h-5 mr-2" />
                    Capture
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="relative w-full h-full">
                  <img 
                    src={capturedImage} 
                    alt="Captured" 
                    className="w-full h-full object-contain"
                  />
                  
                  {isProcessingOCR && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                      <div className="bg-background/90 backdrop-blur-sm rounded-lg p-4 flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground">Extracting text...</span>
                      </div>
                    </div>
                  )}

                  {!isProcessingOCR && selectableTexts.length > 0 && (
                    <div className="absolute inset-0 p-4 overflow-auto pointer-events-none">
                      <div className="max-w-2xl mx-auto pointer-events-auto">
                        {detectedIDs.length > 0 && (
                          <div className="mb-4 space-y-2">
                            <div className="text-xs text-white/70 font-medium mb-1 px-2">Product IDs</div>
                            {detectedIDs.map((id, index) => (
                              <button
                                key={`id-${index}`}
                                onClick={() => useDetectedID(id)}
                                className="w-full bg-primary/95 hover:bg-primary text-primary-foreground rounded-lg px-4 py-3 text-base font-mono font-bold shadow-lg transition-all hover:scale-[1.02] active:scale-95 flex items-center justify-between"
                              >
                                <span>{id}</span>
                                <Search className="w-4 h-4" />
                              </button>
                            ))}
                          </div>
                        )}
                        
                        <div className="bg-black/60 backdrop-blur-sm rounded-lg p-3">
                          <div className="text-xs text-white/70 font-medium mb-2 px-1">Tap any text to search</div>
                          <div className="flex flex-wrap gap-2">
                            {selectableTexts.map((item, index) => (
                              <button
                                key={index}
                                onClick={() => handleTextSelect(item.text)}
                                className={`px-3 py-2 rounded-md text-sm font-medium transition-all hover:scale-105 active:scale-95 ${
                                  item.isNumber
                                    ? 'bg-primary/80 hover:bg-primary text-primary-foreground font-mono'
                                    : 'bg-white/20 hover:bg-white/30 text-white'
                                }`}
                              >
                                {item.text}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                
                {!isProcessingOCR && selectableTexts.length === 0 && (
                  <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/80 to-transparent">
                    <Button 
                      onClick={retakePhoto}
                      variant="outline"
                      className="w-full bg-white/10 hover:bg-white/20 text-white border-white/30"
                      size="lg"
                    >
                      Retake Photo
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* History Dialog */}
      <Dialog open={showHistoryDialog} onOpenChange={setShowHistoryDialog}>
        <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
          <DialogTitle>Search History</DialogTitle>
          <DialogDescription>Your recent product searches</DialogDescription>
          
          {searchHistory.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">No search history yet</p>
          ) : (
            <div className="space-y-3">
              {searchHistory.map((item) => (
                <div key={item.id} className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent transition-colors">
                  {item.thumbnail && (
                    <img 
                      src={item.thumbnail} 
                      alt={item.productId}
                      className="w-16 h-16 object-cover rounded border"
                      loading="lazy"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">ID: {item.productId}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(item.timestamp).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
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
        </DialogContent>
      </Dialog>

      {/* History Button */}
      <Button
        onClick={() => setShowHistoryDialog(true)}
        className="fixed bottom-6 right-6 h-14 w-14 rounded-full shadow-2xl z-50 hover:scale-110 transition-transform"
        size="icon"
        title="Search History"
      >
        <History className="h-6 w-6" />
      </Button>
    </div>
  );
};
