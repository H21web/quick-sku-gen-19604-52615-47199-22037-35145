import React, { useState, useMemo, useRef, useEffect } from 'react';
import { BarcodeDisplay } from '@/components/BarcodeDisplay';
import { ProductImageSearch } from '@/components/ProductImageSearch';
import { QuickSelectChips } from '@/components/QuickSelectChips';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { Package, Weight } from 'lucide-react';
import { ITEMS, QUANTITIES, QUICK_SELECT_PRESETS } from '@/lib/config';

const Index = () => {
  const [selectedItemId, setSelectedItemId] = useState<string>('');
  const [selectedQuantityId, setSelectedQuantityId] = useState<string>('');
  const barcodeRef = useRef<HTMLDivElement>(null);

  const selectedItem = useMemo(() => 
    ITEMS.find(item => item.id === selectedItemId),
    [selectedItemId]
  );

  const selectedQuantity = useMemo(() => 
    QUANTITIES.find(q => q.id === selectedQuantityId),
    [selectedQuantityId]
  );

  const barcodeValue = useMemo(() => {
    if (!selectedItem || !selectedQuantity) return '';
    return `2110000${selectedItem.serialId}${selectedQuantity.serialId}`;
  }, [selectedItem, selectedQuantity]);

  const quickSelectChips = useMemo(() => 
    QUICK_SELECT_PRESETS.map(preset => ({
      itemId: ITEMS[preset.itemIndex]?.id || '',
      quantityId: QUANTITIES[preset.quantityIndex]?.id || '',
      label: `${ITEMS[preset.itemIndex]?.name} ${QUANTITIES[preset.quantityIndex]?.name}`
    })),
    []
  );

  useEffect(() => {
    if (selectedItemId && selectedQuantityId && barcodeRef.current) {
      setTimeout(() => {
        barcodeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
  }, [selectedItemId, selectedQuantityId]);

  const handleQuickSelect = (itemId: string, quantityId: string) => {
    setSelectedItemId(itemId);
    setSelectedQuantityId(quantityId);
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-3 py-4 space-y-4">
        {/* Quick Select */}
        <QuickSelectChips chips={quickSelectChips} onSelect={handleQuickSelect} />

        {/* Selection Grid */}
        <div className="grid grid-cols-2 gap-3">
          {/* Item Selection */}
          <div className="space-y-2">
            <Label className="text-sm font-medium flex items-center gap-1.5">
              <Package className="w-4 h-4 text-primary" />
              Item
            </Label>
            <Select value={selectedItemId} onValueChange={setSelectedItemId}>
              <SelectTrigger className="h-12 text-base">
                <SelectValue placeholder="Select..." />
              </SelectTrigger>
              <SelectContent>
                {ITEMS.map((item) => (
                  <SelectItem key={item.id} value={item.id} className="text-base py-2.5">
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Quantity Selection */}
          <div className="space-y-2">
            <Label className="text-sm font-medium flex items-center gap-1.5">
              <Weight className="w-4 h-4 text-secondary" />
              Quantity
            </Label>
            <Select value={selectedQuantityId} onValueChange={setSelectedQuantityId}>
              <SelectTrigger className="h-12 text-base">
                <SelectValue placeholder="Select..." />
              </SelectTrigger>
              <SelectContent>
                {QUANTITIES.map((quantity) => (
                  <SelectItem key={quantity.id} value={quantity.id} className="text-base py-2.5">
                    {quantity.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Barcode Display */}
        {barcodeValue && selectedItem && selectedQuantity && (
          <div ref={barcodeRef}>
            <BarcodeDisplay 
              value={barcodeValue}
              itemName={selectedItem.name}
              quantityName={selectedQuantity.name}
            />
          </div>
        )}

        {/* Product Image Search */}
        <div className="pt-6 border-t border-border">
          <h2 className="text-xl font-bold mb-4">Product Image Search</h2>
          <ProductImageSearch />
        </div>
      </div>
    </div>
  );
};

export default Index;
