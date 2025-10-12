import Barcode from 'react-barcode';
import { Card } from './ui/card';

interface BarcodeDisplayProps {
  value: string;
  itemName: string;
  quantityName: string;
}

export const BarcodeDisplay = ({ value, itemName, quantityName }: BarcodeDisplayProps) => {
  return (
    <Card className="p-4 bg-card border-2 border-primary shadow-lg">
      <div className="space-y-3">
        <div className="text-center space-y-1">
          <h2 className="text-xl font-bold text-foreground">
            {itemName} - {quantityName}
          </h2>
          <p className="text-xs text-muted-foreground font-mono">{value}</p>
        </div>
        <div className="bg-white p-4 rounded-lg flex justify-center overflow-x-auto">
          <Barcode 
            value={value} 
            format="CODE128"
            width={1.8}
            height={80}
            displayValue={true}
            fontSize={14}
            margin={5}
          />
        </div>
      </div>
    </Card>
  );
};
