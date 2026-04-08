class CaveObstacle {
    constructor(canvasWidth, canvasHeight) {
        this.type = 'cave';
        this.x = canvasWidth;
        this.mountainWidth = Math.random() * 200 + 150;
        
        const minHeight = 50;
        const gap = Math.random() * 150 + 200; 
        const maxAvailableHeight = canvasHeight - gap;
        
        if (maxAvailableHeight > minHeight * 2) {
            this.topMountainHeight = Math.random() * (maxAvailableHeight - minHeight * 2) + minHeight;
            this.bottomMountainHeight = maxAvailableHeight - this.topMountainHeight;
        } else {
            this.topMountainHeight = minHeight;
            this.bottomMountainHeight = minHeight;
        }
        
        this.passed = false;
        this.width = this.mountainWidth; // For generic scoring logic
    }

    update(speed) {
        this.x -= speed;
    }

    checkCollision(planeCenterX, planeTopY, planeBottomY, planeLeftX, planeRightX, canvasHeight) {
        if (planeCenterX > this.x && planeCenterX < this.x + this.mountainWidth) {
            let bottomCurrentHeight = 0;
            let topCurrentHeight = 0;
            
            if (planeCenterX < this.x + this.mountainWidth / 2) {
                let ratio = (planeCenterX - this.x) / (this.mountainWidth / 2);
                bottomCurrentHeight = this.bottomMountainHeight * ratio;
                topCurrentHeight = this.topMountainHeight * ratio;
            } else {
                let ratio = (this.x + this.mountainWidth - planeCenterX) / (this.mountainWidth / 2);
                bottomCurrentHeight = this.bottomMountainHeight * ratio;
                topCurrentHeight = this.topMountainHeight * ratio;
            }
            
            if (planeBottomY > canvasHeight - bottomCurrentHeight) {
                return true; 
            }
            if (topCurrentHeight > 0 && planeTopY < topCurrentHeight) {
                return true; 
            }
        }
        return false;
    }

    draw(ctx, canvasHeight) {
        let snowRatio = 0.3; 
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#00f2fe';

        // Bottom Mountain
        const gradientBottom = ctx.createLinearGradient(0, canvasHeight - this.bottomMountainHeight, 0, canvasHeight);
        gradientBottom.addColorStop(0, '#475569');
        gradientBottom.addColorStop(1, '#0f172a');

        ctx.fillStyle = gradientBottom;
        ctx.beginPath();
        ctx.moveTo(this.x, canvasHeight);
        ctx.lineTo(this.x + this.mountainWidth / 2, canvasHeight - this.bottomMountainHeight);
        ctx.lineTo(this.x + this.mountainWidth, canvasHeight);
        ctx.fill();
        
        ctx.beginPath();
        let snowHeightB = this.bottomMountainHeight * snowRatio;
        let leftXB = this.x + (this.mountainWidth / 2) * (1 - snowRatio);
        let rightXB = this.x + this.mountainWidth / 2 + (this.mountainWidth / 2) * snowRatio;
        
        ctx.moveTo(leftXB, canvasHeight - this.bottomMountainHeight + snowHeightB);
        ctx.lineTo(this.x + this.mountainWidth / 2, canvasHeight - this.bottomMountainHeight);
        ctx.lineTo(rightXB, canvasHeight - this.bottomMountainHeight + snowHeightB);
        ctx.lineTo(this.x + this.mountainWidth / 2, canvasHeight - this.bottomMountainHeight + snowHeightB + 10);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(this.x, canvasHeight);
        ctx.lineTo(this.x + this.mountainWidth / 2, canvasHeight - this.bottomMountainHeight);
        ctx.lineTo(this.x + this.mountainWidth, canvasHeight);
        ctx.stroke();

        // Top Mountain
        if (this.topMountainHeight > 0) {
            const gradientTop = ctx.createLinearGradient(0, 0, 0, this.topMountainHeight);
            gradientTop.addColorStop(0, '#0f172a');
            gradientTop.addColorStop(1, '#475569');

            ctx.fillStyle = gradientTop;
            ctx.beginPath();
            ctx.moveTo(this.x, 0);
            ctx.lineTo(this.x + this.mountainWidth / 2, this.topMountainHeight);
            ctx.lineTo(this.x + this.mountainWidth, 0);
            ctx.fill();
            
            ctx.beginPath();
            let snowHeightT = this.topMountainHeight * snowRatio;
            let leftXT = this.x + (this.mountainWidth / 2) * (1 - snowRatio);
            let rightXT = this.x + this.mountainWidth / 2 + (this.mountainWidth / 2) * snowRatio;
            
            ctx.moveTo(leftXT, this.topMountainHeight - snowHeightT);
            ctx.lineTo(this.x + this.mountainWidth / 2, this.topMountainHeight);
            ctx.lineTo(rightXT, this.topMountainHeight - snowHeightT);
            ctx.lineTo(this.x + this.mountainWidth / 2, this.topMountainHeight - snowHeightT - 10);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.fill();

            ctx.beginPath();
            ctx.moveTo(this.x, 0);
            ctx.lineTo(this.x + this.mountainWidth / 2, this.topMountainHeight);
            ctx.lineTo(this.x + this.mountainWidth, 0);
            ctx.stroke();
        }
    }
}
