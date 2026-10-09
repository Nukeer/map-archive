import { Component, Input } from '@angular/core';
import { BlocoPlanilha } from './blocos';
import { CelulaPlanilha, referencia } from './planilha';

/**
 * Página separada em blocos, cada um com sua grade compacta. As células têm `data-celula`, então
 * clique e arraste são tratados pelo modal (como na planilha completa).
 */
@Component({
  selector: 'app-blocos-planilha',
  standalone: true,
  templateUrl: './blocos-planilha.component.html',
  styleUrls: ['./blocos-planilha.component.scss'],
})
export class BlocosPlanilhaComponent {
  @Input({ required: true }) blocos: BlocoPlanilha[] = [];
  @Input() marcas: ReadonlyMap<number, { tipo: string; papel: string }> = new Map();

  /** Referência na planilha completa, a que o mapeamento usa. */
  ref(c: CelulaPlanilha): string {
    return `Pág.${c.pagina}!${referencia(c)}`;
  }

  /** Linhas da planilha completa cobertas pelo bloco. */
  linhas(b: BlocoPlanilha): string {
    const numeros = b.grade.map(l => l.find(c => c)!.linha);
    const [primeira, ultima] = [numeros[0], numeros[numeros.length - 1]];
    return primeira === ultima ? `linha ${primeira}` : `linhas ${primeira}–${ultima}`;
  }
}
