import { Button } from './ui/button';
import { Zap } from 'lucide-react';

interface QuickSelectChip {
  itemId: string;
  quantityId: string;
  label: string;
}

interface QuickSelectChipsProps {
  chips: QuickSelectChip[];
  onSelect: (itemId: string, quantityId: string) => void;
}

export const QuickSelectChips = ({ chips, onSelect }: QuickSelectChipsProps) => {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Zap className="w-4 h-4 text-warning" />
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Quick Select</h3>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {chips.map((chip, index) => (
          <Button
            key={index}
            variant="outline"
            size="lg"
            onClick={() => onSelect(chip.itemId, chip.quantityId)}
            className="h-auto py-3 text-sm font-medium whitespace-normal hover:bg-primary hover:text-primary-foreground hover:border-primary transition-all active:scale-95"
          >
            {chip.label}
          </Button>
        ))}
      </div>
    </div>
  );
};
