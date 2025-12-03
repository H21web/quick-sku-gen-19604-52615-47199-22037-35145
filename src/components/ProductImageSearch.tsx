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
  lastUsed: number;
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
  const imageRef = useRef<HTMLImageElement>(null);
  const touchStartRef = useRef<{ distance: number; zoom: number; x: number; y: number } | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const lastTapRef = useRef(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [showCameraDialog, setShowCameraDialog] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [isProcessingOCR, setIsProcessingOCR] = useState(false);
  const [extractedText, setExtractedText] = useState('');
  const [detectedIDs, setDetectedIDs] = useState<string[]>([]);
  const [selectableTexts, setSelectableTexts] = useState<Array<{ text: string; isNumber: boolean }>>([]);
  const [jiomartUrl, setJiomartUrl] = useState('');
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([]);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const [searchTime, setSearchTime] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // API Key Management State
  const [apiKeyStatuses, setApiKeyStatuses] = useState<ApiKeyStatus[]>(() =>
    GOOGLE_API_KEYS.map(key => ({ key, exhausted: false, lastUsed: 0 }))
  );
  const searchAbortControllerRef = useRef<AbortController | null>(null);

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
  }, []);

  // Progressive image loading - mark all as loaded immediately for display, then preload in background
  const progressiveImageLoader = useCallback(async (images: string[]) => {
    if (images.length === 0) return;
    
    // Immediately mark first 8 images as "loaded" for instant display
    const firstBatch = new Set(images.slice(0, 8));
    setLoadedImages(firstBatch);

    // Preload function
    const preloadImage = (url: string): Promise<void> => {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          setLoadedImages(prev => new Set([...prev, url]));
          resolve();
        };
        img.onerror = () => {
          // Still mark as loaded to show placeholder behavior
          setLoadedImages(prev => new Set([...prev, url]));
          resolve();
        };
        img.src = url;
      });
    };

    // Preload first batch immediately
    await Promise.all(images.slice(0, 8).map(preloadImage));

    // Load remaining images in parallel batches
    const remaining = images.slice(8);
    for (let i = 0; i < remaining.length; i += 10) {
      const batch = remaining.slice(i, i + 10);
      // Mark batch as loaded immediately for display
      setLoadedImages(prev => new Set([...prev, ...batch]));
      // Preload in background
      Promise.all(batch.map(preloadImage));
      await new Promise(r => setTimeout(r, 50));
    }
  }, []);

  // Save search to history with thumbnail caching and deduplication
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

  // Get next available API key
  const getNextApiKey = useCallback((): string | null => {
    const now = Date.now();
    const hourAgo = now - 3600000;

    setApiKeyStatuses(prev =>
      prev.map(status =>
        status.exhausted && status.lastUsed < hourAgo
          ? { ...status, exhausted: false }
          : status
      )
    );

    const availableKey = apiKeyStatuses.find(status => !status.exhausted);
    return availableKey?.key || null;
  }, [apiKeyStatuses]);

  // Mark API key as exhausted
  const markApiKeyExhausted = useCallback((apiKey: string) => {
    setApiKeyStatuses(prev =>
      prev.map(status =>
        status.key === apiKey
          ? { ...status, exhausted: true, lastUsed: Date.now() }
          : status
      )
    );
  }, []);

  // Update last used timestamp
  const updateApiKeyUsed = useCallback((apiKey: string) => {
    setApiKeyStatuses(prev =>
      prev.map(status =>
        status.key === apiKey
          ? { ...status, lastUsed: Date.now() }
          : status
      )
    );
  }, []);

  // Fetch with API key rotation
  const fetchWithApiKeyRotation = async (
    buildUrl: (apiKey: string) => string,
    maxRetries: number = GOOGLE_API_KEYS.length
  ): Promise<Response> => {
    let lastError: Error | null = null;
    let attempts = 0;

    while (attempts < maxRetries) {
      const apiKey = getNextApiKey();
      if (!apiKey) {
        throw new Error('All API keys exhausted. Please try again later.');
      }

      try {
        const url = buildUrl(apiKey);
        const response = await fetch(url);

        if (response.ok) {
          updateApiKeyUsed(apiKey);
          return response;
        }

        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.error?.message || '';

        if (
          response.status === 429 ||
          errorMessage.includes('quota') ||
          errorMessage.includes('limit') ||
          errorMessage.includes('rateLimitExceeded')
        ) {
          console.warn(`API key exhausted: ${apiKey.substring(0, 10)}...`);
          markApiKeyExhausted(apiKey);
          attempts++;
          continue;
        }

        throw new Error(errorMessage || `Request failed with status ${response.status}`);
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

    // Cancel any ongoing search
    if (searchAbortControllerRef.current) {
      searchAbortControllerRef.current.abort();
    }

    searchAbortControllerRef.current = new AbortController();
    const startTime = performance.now();
    setLoading(true);
    
    // Reset loaded images for fresh search
    setLoadedImages(new Set());

    try {
      const query = `site:jiomart.com ${idToSearch}`;

      // Parallel search for both images and web results with API rotation
      const [imageResponse, webResponse] = await Promise.all([
        fetchWithApiKeyRotation((apiKey) =>
          `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&searchType=image&num=10&fields=items(link)`
        ),
        fetchWithApiKeyRotation((apiKey) =>
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
        // Reset state ONLY when no images found
        setExtractedImages([]);
        setLoadedImages(new Set());
        setJiomartUrl(foundUrl);
        setSearchTime(null);
        toast.error('No images found');
        saveToHistory(idToSearch, foundUrl);
        return;
      }

      // Get unique JioMart image links
      const jiomartLinks = Array.from(new Set(
        imageData.items
          .map((item: any) => item.link)
          .filter((url: string) => url.includes('jiomart.com/images/product'))
      ));

      if (!jiomartLinks.length) {
        // Reset state ONLY when no product images found
        setExtractedImages([]);
        setLoadedImages(new Set());
        setJiomartUrl(foundUrl);
        setSearchTime(null);
        toast.error('No product images found');
        saveToHistory(idToSearch, foundUrl);
        return;
      }

      // Extract images in parallel with increased batch size
      const batchSize = 15;
      const allImages: string[] = [];

      for (let i = 0; i < jiomartLinks.length; i += batchSize) {
        const batch = jiomartLinks.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map((url: string) =>
            Promise.race([
              extractAllProductImages(url),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout')), 5000)
              )
            ])
          )
        );

        results.forEach((r) => {
          if (r.status === 'fulfilled' && Array.isArray(r.value)) {
            allImages.push(...r.value);
          }
        });
      }

      // Filter unique images
      const uniqueImages = Array.from(new Set(allImages));

      // Sort: original images first, then others
      const sortedImages = [
        ...uniqueImages.filter(url => url.includes('/original/')),
        ...uniqueImages.filter(url => !url.includes('/original/'))
      ];

      if (!sortedImages.length) {
        // Reset state ONLY when no sorted images found
        setExtractedImages([]);
        setLoadedImages(new Set());
        setJiomartUrl(foundUrl);
        setSearchTime(null);
        toast.error('No images found');
        saveToHistory(idToSearch, foundUrl);
        return;
      }

      // Set images and start loading immediately
      setExtractedImages(sortedImages);
      setJiomartUrl(foundUrl);
      
      // Start progressive loading immediately - this will set loadedImages
      progressiveImageLoader(sortedImages);

      // Save to history with first image as thumbnail
      const thumbnail = sortedImages[0];
      saveToHistory(idToSearch, foundUrl, thumbnail);
      toast.success(`Found ${sortedImages.length} images`);

      const endTime = performance.now();
      setSearchTime((endTime - startTime) / 1000);

    } catch (error: any) {
      console.error('Search error:', error);
      // Reset state on error
      setExtractedImages([]);
      setLoadedImages(new Set());
      setJiomartUrl('');
      setSearchTime(null);
      
      if (error.message.includes('exhausted')) {
        toast.error('All API keys exhausted. Please try again in an hour.');
      } else {
        toast.error(error.message || 'Search failed. Try again.');
      }

      const endTime = performance.now();
      setSearchTime((endTime - startTime) / 1000);
    } finally {
      setLoading(false);
      searchAbortControllerRef.current = null;
    }
  }, [productId, saveToHistory, progressiveImageLoader, getNextApiKey, markApiKeyExhausted, updateApiKeyUsed, fetchWithApiKeyRotation]);

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

  // Touch event handlers for pinch-to-zoom
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

  const extractTextFromImage = async (imageData: string) => {
    setIsProcessingOCR(true);

    try {
      const img = new Image();
      img.src = imageData;
      await new Promise((resolve) => { img.onload = resolve; });

      const canvas = document.createElement('canvas');
      const maxDimension = 1200;
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
        ctx.filter = 'contrast(1.2) brightness(1.1)';
        ctx.drawImage(img, 0, 0, width, height);
      }

      const compressedImage = canvas.toDataURL('image/jpeg', 0.85);

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
    };
  }, [cameraStream]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-pink-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl md:text-5xl font-bold bg-gradient-to-r from-purple-600 to-pink-600 bg-clip-text text-transparent mb-2">
            Product Image Finder
          </h1>
          <p className="text-gray-600">Search JioMart products by ID</p>
        </div>

        {/* Search Section */}
        <div className="bg-white rounded-2xl shadow-xl p-6 mb-8">
          <div className="flex flex-col sm:flex-row gap-3">
            <Input
              type="text"
              placeholder="Enter Product ID..."
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="flex-1"
            />
            <Button onClick={() => handleSearch()} disabled={loading}>
              <Search className="w-4 h-4 mr-2" />
              {loading ? 'Finding...' : 'Find'}
            </Button>
            <Button onClick={startCamera} variant="outline">
              <Scan className="w-4 h-4 mr-2" />
              Scan
            </Button>
          </div>
        </div>

        {/* Loading Skeletons */}
        {loading && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 mb-8">
            {[...Array(8)].map((_, i) => (
              <Skeleton key={i} className="aspect-square rounded-lg" />
            ))}
          </div>
        )}

        {/* Extracted Images Grid */}
        {extractedImages.length > 0 && (
          <div className="bg-white rounded-2xl shadow-xl p-6">
            <div className="flex flex-wrap items-center justify-between mb-4 gap-2">
              <h2 className="text-2xl font-bold text-gray-800">
                Product Images ({extractedImages.length})
              </h2>
              {searchTime !== null && (
                <span className="text-sm text-gray-500">
                  {searchTime.toFixed(2)}s
                </span>
              )}
              {loadedImages.size < extractedImages.length && (
                <span className="text-sm text-purple-600">
                  {loadedImages.size}/{extractedImages.length}
                </span>
              )}
              {jiomartUrl && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(jiomartUrl, '_blank')}
                  className="gap-2"
                >
                  <ExternalLink className="w-4 h-4" />
                  Open Product
                </Button>
              )}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {extractedImages.map((url, index) => {
                const isLoaded = loadedImages.has(url);
                return (
                  <div
                    key={index}
                    onClick={() => openImage(index)}
                    className="relative aspect-square rounded-lg overflow-hidden cursor-pointer group bg-gray-100 hover:ring-4 hover:ring-purple-400 transition-all"
                  >
                    <img
                      src={url}
                      alt={`Product ${index + 1}`}
                      className={`w-full h-full object-cover transition-opacity duration-300 ${
                        isLoaded ? 'opacity-100' : 'opacity-0'
                      }`}
                      loading="lazy"
                    />
                    {!isLoaded && (
                      <Skeleton className="absolute inset-0" />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Image Viewer Dialog */}
        <Dialog open={selectedImageIndex !== null} onOpenChange={(open) => !open && closeImage()}>
          <DialogContent className="max-w-[95vw] max-h-[95vh] p-0 overflow-hidden bg-black/95">
            <DialogTitle className="sr-only">Product Image Viewer</DialogTitle>
            <DialogDescription className="sr-only">View and navigate product images</DialogDescription>
            {selectedImageIndex !== null && (
              <div className="relative w-full h-full flex items-center justify-center">
                {/* Zoom Controls */}
                <div className="absolute top-4 right-4 z-10 flex gap-2">
                  <Button
                    size="icon"
                    variant="secondary"
                    onClick={handleZoomOut}
                    disabled={zoom <= 0.5}
                  >
                    <ZoomOut className="w-4 h-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="secondary"
                    onClick={handleZoomIn}
                    disabled={zoom >= 5}
                  >
                    <ZoomIn className="w-4 h-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="secondary"
                    onClick={closeImage}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>

                {/* Previous Button */}
                {selectedImageIndex > 0 && (
                  <Button
                    size="icon"
                    variant="secondary"
                    className="absolute left-4 z-10"
                    onClick={goToPrevious}
                  >
                    <ChevronLeft className="w-6 h-6" />
                  </Button>
                )}

                {/* Image */}
                <div
                  onClick={(e) => e.stopPropagation()}
                  onTouchStart={handleTouchStart}
                  onTouchMove={handleTouchMove}
                  onTouchEnd={handleTouchEnd}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseLeave}
                  className="w-full h-full flex items-center justify-center overflow-hidden"
                >
                  <img
                    ref={imageRef}
                    src={extractedImages[selectedImageIndex]}
                    alt={`Product ${selectedImageIndex + 1}`}
                    style={{
                      transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})`,
                      transition: isTransitioning ? 'transform 0.3s ease-out' : 'none',
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

                {/* Next Button */}
                {selectedImageIndex < extractedImages.length - 1 && (
                  <Button
                    size="icon"
                    variant="secondary"
                    className="absolute right-4 z-10"
                    onClick={goToNext}
                  >
                    <ChevronRight className="w-6 h-6" />
                  </Button>
                )}

                {/* Image Counter */}
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/60 text-white px-4 py-2 rounded-full text-sm">
                  {selectedImageIndex + 1} / {extractedImages.length}
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Camera Dialog */}
        <Dialog open={showCameraDialog} onOpenChange={(open) => !open && stopCamera()}>
          <DialogContent className="max-w-[95vw] max-h-[95vh] p-6">
            <DialogTitle>Camera Scanner</DialogTitle>
            <DialogDescription>Capture product image for text extraction</DialogDescription>
            {!capturedImage ? (
              <>
                <div className="relative bg-black rounded-lg overflow-hidden">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    className="w-full h-auto"
                  />
                  <canvas ref={canvasRef} className="hidden" />
                </div>
                <p className="text-sm text-gray-600 text-center">Position product ID within the frame</p>
                <Button onClick={captureImage} className="w-full">
                  Capture
                </Button>
              </>
            ) : (
              <>
                <img src={capturedImage} alt="Captured" className="w-full rounded-lg" />
                {isProcessingOCR && (
                  <p className="text-center text-purple-600">Extracting text...</p>
                )}
                {!isProcessingOCR && selectableTexts.length > 0 && (
                  <div className="space-y-3">
                    {detectedIDs.length > 0 && (
                      <div className="space-y-2">
                        <h3 className="font-semibold text-sm">Product IDs</h3>
                        {detectedIDs.map((id, index) => (
                          <button
                            key={index}
                            onClick={() => useDetectedID(id)}
                            className="w-full bg-primary/95 hover:bg-primary text-primary-foreground rounded-lg px-4 py-3 text-base font-mono font-bold shadow-lg transition-all hover:scale-[1.02] active:scale-95 flex items-center justify-between"
                          >
                            {id}
                            <Search className="w-4 h-4" />
                          </button>
                        ))}
                      </div>
                    )}
                    <p className="text-sm text-gray-600">Tap any text to search</p>
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
                )}
                {!isProcessingOCR && selectableTexts.length === 0 && (
                  <Button onClick={retakePhoto} variant="outline" className="w-full">
                    Retake Photo
                  </Button>
                )}
              </>
            )}
          </DialogContent>
        </Dialog>

        {/* History Dialog with Thumbnails */}
        <Dialog open={showHistoryDialog} onOpenChange={setShowHistoryDialog}>
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
            <DialogTitle>Search History</DialogTitle>
            <DialogDescription>Your recent product searches</DialogDescription>
            {searchHistory.length === 0 ? (
              <p className="text-center text-gray-500 py-8">No search history yet</p>
            ) : (
              <div className="space-y-3">
                {searchHistory.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
                  >
                    {item.thumbnail && (
                      <img
                        src={item.thumbnail}
                        alt=""
                        className="w-16 h-16 object-cover rounded"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-mono font-semibold">ID: {item.productId}</p>
                      <p className="text-sm text-gray-500">
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
                        <Search className="w-4 h-4" />
                      </Button>
                      {item.jiomartUrl && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => window.open(item.jiomartUrl, '_blank')}
                        >
                          <ExternalLink className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Fixed History Button */}
        <Button
          onClick={() => setShowHistoryDialog(true)}
          className="fixed bottom-6 right-6 h-14 w-14 rounded-full shadow-2xl z-50 hover:scale-110 transition-transform"
          size="icon"
          title="Search History"
        >
          <History className="w-6 h-6" />
        </Button>
      </div>
    </div>
  );
};
